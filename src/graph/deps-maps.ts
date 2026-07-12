import {
	buildWildcardPrefixes,
	normalizePath,
	pathDependencies,
} from "../dag/index.js";
import { enumeratedPaths } from "../tracking/enumeration.js";
import { dryRunProxy } from "../tracking/proxy.js";
import type { FlatNode } from "./flatten.js";

function isThenable(value: unknown): value is PromiseLike<unknown> {
	return (
		value !== null &&
		(typeof value === "object" || typeof value === "function") &&
		typeof (value as PromiseLike<unknown>).then === "function"
	);
}

/**
 * Returns the computed nodes a formula depends on by virtue of *enumerating* a
 * container (object spread, `Object.keys`, `for...in`). Enumeration means the
 * formula reads the whole container, so it depends on every computed descendant
 * — including ones not yet present in state when the spread ran.
 *
 * `enumerated` is the set of enumerated container paths recorded by the proxy's
 * `ownKeys` trap. A plain property read (`f.nested.value`) does not enumerate,
 * so it is not here and its unrelated siblings are never pulled in. This
 * distinguishes a genuine whole-container read from incidental traversal via
 * access-mode provenance rather than a path-shape heuristic.
 */
export function containerDescendants(
	enumerated: Iterable<string>,
	self: string,
	nodePaths: Iterable<string>,
	wildcardPrefixes?: ReadonlySet<string>,
): Set<string> {
	const result = new Set<string>();
	const nodes = [...nodePaths];
	for (const rawPath of enumerated) {
		const containerPath = normalizePath(rawPath, wildcardPrefixes);
		const prefix = containerPath ? `${containerPath}.` : "";
		for (const candidate of nodes) {
			if (candidate !== self && candidate.startsWith(prefix)) {
				result.add(candidate);
			}
		}
	}
	return result;
}

/**
 * Builds a map from each node path to the set of paths it reads.
 * Runs each formula/deps function with a dry-run proxy to capture accessed paths.
 */
export function buildDepsMap(nodes: FlatNode[]): Map<string, Set<string>> {
	const depsMap = new Map<string, Set<string>>();
	const nodePaths = nodes.map((n) => n.path);
	const wildcardPrefixes = buildWildcardPrefixes(nodePaths);
	for (const node of nodes) {
		const accessed = new Set<string>();
		const rootProxy = dryRunProxy(accessed, "");
		let itemProxy: unknown;

		if (node.isEach) {
			const parts = node.path.split(".");
			const wildcardIndex = parts.lastIndexOf("*");
			const itemPath = parts.slice(0, wildcardIndex + 1).join(".");
			itemProxy = dryRunProxy(accessed, itemPath);
		}

		try {
			// (item, root) for each nodes; (state, root) where state is root otherwise.
			const result = node.isEach
				? node.fn(itemProxy as unknown, rootProxy as unknown)
				: node.fn(rootProxy as unknown, rootProxy as unknown);

			// Async formulas return a Promise before touching inputs after the first
			// await; swallow any later rejection so a dry run during createGraph
			// cannot surface as an unhandled rejection. Sync accesses are already
			// captured synchronously above.
			if (isThenable(result)) {
				Promise.resolve(result).catch(() => {});
			}
		} catch {
			// Expected — accessing dry-run proxies can throw synchronously.
			// Sync accesses are already captured.
		}

		// Enumerating a whole container (spread / Object.keys) depends on its
		// computed descendants, even ones not present during the dry run.
		const descendants = containerDescendants(
			enumeratedPaths(accessed),
			node.path,
			nodePaths,
			wildcardPrefixes,
		);

		// Also depend on the parent object implicitly (if path is "a.b", it depends on "a")
		const parts = node.path.split(".");
		for (let i = 1; i < parts.length; i++) {
			const parentPath = parts.slice(0, i).join(".");
			accessed.add(parentPath);
		}

		const deps = pathDependencies(accessed, node.path, wildcardPrefixes);
		for (const descendant of descendants) deps.add(descendant);
		depsMap.set(node.path, deps);
	}

	return depsMap;
}

/**
 * Builds the reverse dependency map: for each key, the set of computed nodes that read it.
 */
export function buildReverseDepsMap(
	depsMap: ReadonlyMap<string, ReadonlySet<string>>,
): Map<string, Set<string>> {
	const reverseMap = new Map<string, Set<string>>();
	for (const [node, deps] of depsMap) {
		for (const dep of deps) {
			let set = reverseMap.get(dep);
			if (!set) {
				set = new Set();
				reverseMap.set(dep, set);
			}
			set.add(node);
		}
	}
	return reverseMap;
}
