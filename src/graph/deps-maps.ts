import { pathDependencies } from "../dag/index.js";
import { dryRunProxy } from "../tracking/proxy.js";
import type { FlatNode } from "./flatten.js";

/**
 * Builds a map from each node path to the set of paths it reads.
 * Runs each formula/deps function with a dry-run proxy to capture accessed paths.
 */
export function buildDepsMap(nodes: FlatNode[]): Map<string, Set<string>> {
	const depsMap = new Map<string, Set<string>>();
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
			if (node.isEach) {
				// (item, root) signature
				node.fn(itemProxy as unknown, rootProxy as unknown);
			} else {
				// (state, root) where state is root
				node.fn(rootProxy as unknown, rootProxy as unknown);
			}
		} catch {
			// Expected — async formulas will throw. Sync accesses are already captured.
		}

		// Also depend on the parent object implicitly (if path is "a.b", it depends on "a")
		const parts = node.path.split(".");
		for (let i = 1; i < parts.length; i++) {
			const parentPath = parts.slice(0, i).join(".");
			accessed.add(parentPath);
		}

		depsMap.set(node.path, pathDependencies(accessed, node.path));
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
