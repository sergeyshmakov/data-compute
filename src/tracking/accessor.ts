import { normalizePath } from "../dag";
import { dryRunProxy } from "./proxy";

/** Resolves `(x) => x.total` to the string `"total"` via a dry-run proxy. */
export function resolveAccessor<T>(accessor: (x: T) => unknown): string {
	const deps = new Set<string>();
	accessor(dryRunProxy(deps) as T);
	for (const p of deps) return normalizePath(p);
	throw new Error("Accessor did not access any property");
}
