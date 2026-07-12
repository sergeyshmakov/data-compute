import { normalizePath } from "../dag/index.js";

export interface RuntimeExpansion {
	runtimePath: string;
	itemPath: string;
	item: unknown;
}

const unsafePathSegments = new Set(["__proto__", "constructor", "prototype"]);

function assertSafePath(path: string): void {
	for (const segment of path.split(".")) {
		if (unsafePathSegments.has(segment)) {
			throw new Error(`Unsafe path segment "${segment}" in path "${path}".`);
		}
	}
}

export function getByPath(obj: unknown, path: string): unknown {
	if (path === "") return obj;
	const parts = path.split(".");
	let curr: unknown = obj;
	for (const p of parts) {
		if (curr === null || curr === undefined) return undefined;
		// Never traverse into prototype-polluting keys, even on reads.
		if (unsafePathSegments.has(p)) return undefined;
		curr = (curr as Record<string, unknown>)[p];
	}
	return curr;
}

export function setByPath(
	obj: Record<string, unknown>,
	path: string,
	value: unknown,
	wildcardPrefixes?: ReadonlySet<string>,
): void {
	assertSafePath(path);
	const parts = path.split(".");
	// A missing container is created as an array only when the next segment is a
	// genuine array-index (a `*` wildcard position), so numeric object keys
	// (e.g. `Record<number, T>`) don't get coerced into arrays.
	const template = wildcardPrefixes
		? normalizePath(path, wildcardPrefixes).split(".")
		: undefined;
	let curr: Record<string, unknown> = obj;
	for (let i = 0; i < parts.length - 1; i++) {
		const p = parts[i];
		if (
			curr[p] === undefined ||
			curr[p] === null ||
			typeof curr[p] !== "object"
		) {
			const nextIsIndex = template
				? template[i + 1] === "*"
				: /^\d+$/.test(parts[i + 1]);
			curr[p] = nextIsIndex ? [] : {};
		}
		curr = curr[p] as Record<string, unknown>;
	}
	curr[parts[parts.length - 1]] = value;
}

/** Deletes the leaf at `path` if present. Missing intermediate paths are a no-op. */
export function deleteByPath(obj: Record<string, unknown>, path: string): void {
	assertSafePath(path);
	const parts = path.split(".");
	let curr: unknown = obj;
	for (let i = 0; i < parts.length - 1; i++) {
		if (curr === null || typeof curr !== "object") return;
		curr = (curr as Record<string, unknown>)[parts[i]];
	}
	if (curr !== null && typeof curr === "object") {
		delete (curr as Record<string, unknown>)[parts[parts.length - 1]];
	}
}

export function expandRuntimePaths(
	templatePath: string,
	state: Record<string, unknown>,
): RuntimeExpansion[] {
	// Guard before walking segments: a template path must never traverse
	// prototype-polluting keys, consistent with getByPath/setByPath/deleteByPath.
	assertSafePath(templatePath);
	const segments = templatePath.split(".");
	const expansions: RuntimeExpansion[] = [];

	function walk(
		index: number,
		current: unknown,
		runtimeSegments: string[],
		itemPath: string | undefined,
	): void {
		if (index === segments.length) {
			const runtimePath = runtimeSegments.join(".");
			const resolvedItemPath = itemPath ?? runtimePath;
			expansions.push({
				runtimePath,
				itemPath: resolvedItemPath,
				item: getByPath(state, resolvedItemPath),
			});
			return;
		}

		const segment = segments[index];
		if (segment === "*") {
			if (!Array.isArray(current)) return;
			for (let i = 0; i < current.length; i++) {
				const nextSegments = [...runtimeSegments, String(i)];
				walk(index + 1, current[i], nextSegments, nextSegments.join("."));
			}
			return;
		}

		const hasFutureWildcard = segments.slice(index + 1).includes("*");
		if ((current === null || current === undefined) && hasFutureWildcard)
			return;
		const next =
			current === null || current === undefined
				? undefined
				: (current as Record<string, unknown>)[segment];
		walk(index + 1, next, [...runtimeSegments, segment], itemPath);
	}

	walk(0, state, [], undefined);
	return expansions;
}
