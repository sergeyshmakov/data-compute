/**
 * Collects the set of wildcard prefixes present in a set of template node
 * paths. A wildcard prefix is any prefix that ends in a `*` segment, e.g. the
 * template `"items.*.tax"` contributes `"items.*"`. Used to normalize runtime
 * paths without misclassifying genuine numeric object keys as array indices.
 */
export function buildWildcardPrefixes(
	nodePaths: Iterable<string>,
): Set<string> {
	const prefixes = new Set<string>();
	for (const path of nodePaths) {
		const segments = path.split(".");
		for (let i = 0; i < segments.length; i++) {
			if (segments[i] === "*") {
				prefixes.add(segments.slice(0, i + 1).join("."));
			}
		}
	}
	return prefixes;
}

/**
 * Normalizes a runtime path to a template path by replacing array-index
 * segments with `*`.
 * "items.0.price" -> "items.*.price"
 * "nested.array.1" -> "nested.array.*"
 *
 * When `wildcardPrefixes` is supplied, a numeric segment is only treated as an
 * array index (and rewritten to `*`) if the resulting prefix is a known
 * wildcard position in the graph. This keeps genuine numeric object keys
 * (e.g. `Record<number, T>` or status-code maps) from colliding with array
 * indices. When omitted, every all-digits segment is rewritten (legacy
 * behavior).
 */
export function normalizePath(
	path: string,
	wildcardPrefixes?: ReadonlySet<string>,
): string {
	const segments = path.split(".");
	const out: string[] = [];
	for (const segment of segments) {
		if (/^\d+$/.test(segment)) {
			if (!wildcardPrefixes || wildcardPrefixes.has([...out, "*"].join("."))) {
				out.push("*");
				continue;
			}
		}
		out.push(segment);
	}
	return out.join(".");
}

/**
 * Given an accessed path, generates the set of node paths it depends on.
 * If a path like "a.b.c" is accessed, we depend on "a.b.c", "a.b", and "a".
 * This ensures child operations wait for parent objects to be fully constructed.
 */
export function pathDependencies(
	accessed: Set<string>,
	self: string,
	wildcardPrefixes?: ReadonlySet<string>,
): Set<string> {
	const result = new Set<string>();
	const selfTemplate = normalizePath(self, wildcardPrefixes);

	for (const p of accessed) {
		const template = normalizePath(p, wildcardPrefixes);

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
	// Track a head index instead of Array.shift() (which reindexes the whole
	// queue each pop) so large independent-node graphs sort in linear time.
	let head = 0;
	while (head < queue.length) {
		const n = queue[head++];
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
