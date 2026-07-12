import { normalizePath } from "../dag/index.js";
import { dryRunProxy } from "./proxy.js";

/** Resolves `(x) => x.total` to the string `"total"` via a dry-run proxy. */
export function resolveAccessor<T>(
	accessor: (x: T) => unknown,
	wildcardPrefixes?: ReadonlySet<string>,
): string {
	const deps = new Set<string>();
	accessor(dryRunProxy(deps) as T);
	let selected: string | undefined;
	let selectedDepth = -1;
	for (const p of deps) {
		const normalized = normalizePath(p, wildcardPrefixes);
		const depth = normalized.split(".").length;
		if (depth >= selectedDepth) {
			selected = normalized;
			selectedDepth = depth;
		}
	}
	if (selected) return selected;
	throw new Error("Accessor did not access any property");
}
