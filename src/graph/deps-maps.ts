import {
	buildWildcardPrefixes,
	normalizePath,
	pathDependencies,
} from "../dag/index.js";
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
 * Given the paths a formula actually read, returns the computed nodes it depends
 * on by virtue of reading a whole container.
 *
 * A "container read" is a maximal accessed path — one with no deeper accessed
 * path beneath it. Reading `{ ...f.nested }` records only `nested` (maximal), so
 * it depends on every computed descendant (`nested.value`, ...). A leaf read
 * like `f.nested.value` records `nested` AND `nested.value`; only the latter is
 * maximal, so `nested` is treated as incidental traversal and is NOT expanded —
 * which avoids pulling in unrelated computed siblings (and the false cycles that
 * would create).
 *
 * Callers must pass the dry-run/runtime accessed set only, never the injected
 * ancestor paths, or independent siblings would be linked.
 */
export function containerDescendants(
	accessed: Iterable<string>,
	self: string,
	nodePaths: Iterable<string>,
	wildcardPrefixes?: ReadonlySet<string>,
): Set<string> {
	const normalized = new Set<string>();
	for (const path of accessed) {
		normalized.add(normalizePath(path, wildcardPrefixes));
	}

	const result = new Set<string>();
	const nodes = [...nodePaths];
	for (const containerPath of normalized) {
		const prefix = `${containerPath}.`;
		// Only maximal paths represent a whole-container read.
		let hasDeeper = false;
		for (const other of normalized) {
			if (other !== containerPath && other.startsWith(prefix)) {
				hasDeeper = true;
				break;
			}
		}
		if (hasDeeper) continue;

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

		// Reading a whole container depends on its computed descendants. Compute
		// this from the dry-run accesses only, before injecting ancestor paths
		// below (injected ancestors must not be treated as container reads).
		const descendants = containerDescendants(
			accessed,
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
