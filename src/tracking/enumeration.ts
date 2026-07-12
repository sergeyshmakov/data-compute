/**
 * Access-mode provenance for container reads.
 *
 * A formula that *enumerates* a container — object spread `{ ...f.nested }`,
 * `Object.keys`, `for...in`, all of which trip the proxy's `ownKeys` trap —
 * depends on the whole container, including computed children that are not yet
 * present in state. That is fundamentally different from a *property read*
 * (`f.nested.value`), which records only the path it touched.
 *
 * The tracking proxies cannot express "I read the whole container" through the
 * accessed-path set alone (a spread of `{ label }` records `nested` and
 * `nested.label`, indistinguishable from a targeted read). So enumeration is
 * recorded separately here, keyed by the same accessed-path Set that the proxy
 * already threads, and consumed when expanding container dependencies.
 *
 * The WeakMap keys are per-compute-per-node accessed Sets, so entries are
 * short-lived and collected automatically.
 */
const enumeratedByAccessSet = new WeakMap<Set<string>, Set<string>>();
const EMPTY: ReadonlySet<string> = new Set<string>();

/** Records that the container at `path` was enumerated during this access pass. */
export function markEnumerated(accessed: Set<string>, path: string): void {
	let set = enumeratedByAccessSet.get(accessed);
	if (!set) {
		set = new Set<string>();
		enumeratedByAccessSet.set(accessed, set);
	}
	set.add(path);
}

/** Returns the container paths enumerated for a given accessed-path Set. */
export function enumeratedPaths(accessed: Set<string>): ReadonlySet<string> {
	return enumeratedByAccessSet.get(accessed) ?? EMPTY;
}
