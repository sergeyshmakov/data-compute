import { buildWildcardPrefixes, pathDependencies } from "../dag/index.js";
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
 * Builds a map from each node path to the set of paths it reads.
 * Runs each formula/deps function with a dry-run proxy to capture accessed paths.
 */
export function buildDepsMap(nodes: FlatNode[]): Map<string, Set<string>> {
	const depsMap = new Map<string, Set<string>>();
	const wildcardPrefixes = buildWildcardPrefixes(nodes.map((n) => n.path));
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

		// Also depend on the parent object implicitly (if path is "a.b", it depends on "a")
		const parts = node.path.split(".");
		for (let i = 1; i < parts.length; i++) {
			const parentPath = parts.slice(0, i).join(".");
			accessed.add(parentPath);
		}

		depsMap.set(
			node.path,
			pathDependencies(accessed, node.path, wildcardPrefixes),
		);
	}

	// Expand container reads to their computed descendants. A formula that reads
	// a whole container (e.g. `{ ...f.nested }`) records only the parent path
	// "nested", which matches no exact node, so it would run before a computed
	// child like "nested.value" and publish stale data. For each such dependency
	// add the computed descendant nodes. Skip a node's own ancestor paths —
	// expanding those would link independent siblings and create false cycles.
	const nodePaths = nodes.map((n) => n.path);
	for (const [node, deps] of depsMap) {
		const expanded = new Set(deps);
		for (const dep of deps) {
			if (node === dep || node.startsWith(`${dep}.`)) continue;
			const prefix = `${dep}.`;
			for (const candidate of nodePaths) {
				if (candidate !== node && candidate.startsWith(prefix)) {
					expanded.add(candidate);
				}
			}
		}
		depsMap.set(node, expanded);
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
