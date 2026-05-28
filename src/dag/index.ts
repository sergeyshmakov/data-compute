/**
 * Normalizes a runtime path to a template path.
 * "items.0.price" -> "items.*.price"
 * "nested.array.1" -> "nested.array.*"
 */
export function normalizePath(path: string): string {
	return path
		.split(".")
		.map((segment) => (/^\d+$/.test(segment) ? "*" : segment))
		.join(".");
}

/**
 * Given an accessed path, generates the set of node paths it depends on.
 * If a path like "a.b.c" is accessed, we depend on "a.b.c", "a.b", and "a".
 * This ensures child operations wait for parent objects to be fully constructed.
 */
export function pathDependencies(
	accessed: Set<string>,
	self: string,
): Set<string> {
	const result = new Set<string>();
	const selfTemplate = normalizePath(self);

	for (const p of accessed) {
		const template = normalizePath(p);

		// Add the full path
		if (template !== selfTemplate) {
			result.add(template);
		}

		// Add all parent paths
		const parts = template.split(".");
		for (let i = 1; i < parts.length; i++) {
			const parent = parts.slice(0, i).join(".");
			if (parent !== selfTemplate) {
				result.add(parent);
			}
		}
	}
	return result;
}

interface TopoResult {
	order: string[];
	hasCycle: boolean;
}

/**
 * Kahn's algorithm. `adj` maps each node to the set of nodes it depends ON.
 * Returns nodes in execution order (dependencies before dependents).
 */
export function topoSort(
	nodes: string[],
	adj: ReadonlyMap<string, ReadonlySet<string>>,
): TopoResult {
	const uniqueNodes = [...new Set(nodes)];
	// Build in-degree (count of *computed* predecessors) and reverse adjacency
	const inDeg = new Map<string, number>();
	const successors = new Map<string, string[]>(); // dependency → nodes that need it

	const nodeSet = new Set(uniqueNodes);
	for (const n of uniqueNodes) {
		let count = 0;
		const deps = adj.get(n);
		if (deps) {
			for (const d of deps) {
				if (nodeSet.has(d)) {
					count++;
					let list = successors.get(d);
					if (!list) {
						list = [];
						successors.set(d, list);
					}
					list.push(n);
				}
			}
		}
		inDeg.set(n, count);
	}

	const queue: string[] = [];
	for (const [n, deg] of inDeg) {
		if (deg === 0) queue.push(n);
	}

	const order: string[] = [];
	while (queue.length > 0) {
		const n = queue.shift();
		if (n === undefined) break;
		order.push(n);
		for (const s of successors.get(n) ?? []) {
			const deg = inDeg.get(s);
			if (deg === undefined) continue;
			const next = deg - 1;
			inDeg.set(s, next);
			if (next === 0) queue.push(s);
		}
	}

	return { order, hasCycle: order.length < uniqueNodes.length };
}
