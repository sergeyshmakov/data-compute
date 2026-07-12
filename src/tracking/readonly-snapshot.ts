import { markEnumerated } from "./enumeration.js";

const ARRAY_SHORT_CIRCUIT_METHODS = new Set<PropertyKey>([
	"find",
	"findIndex",
	"findLast",
	"findLastIndex",
	"some",
	"every",
]);
const MAP_MUTATORS = new Set<PropertyKey>(["set", "delete", "clear"]);
const SET_MUTATORS = new Set<PropertyKey>(["add", "delete", "clear"]);
const DATE_MUTATORS = new Set<PropertyKey>([
	"setTime",
	"setMilliseconds",
	"setSeconds",
	"setMinutes",
	"setHours",
	"setDate",
	"setMonth",
	"setFullYear",
	"setUTCMilliseconds",
	"setUTCSeconds",
	"setUTCMinutes",
	"setUTCHours",
	"setUTCDate",
	"setUTCMonth",
	"setUTCFullYear",
	"setYear",
]);

/**
 * Proxy cache keyed by target object and then by the path at which it is
 * reached. Keying by path (not object identity alone) keeps dependency
 * tracking correct when the same object is aliased under multiple paths, while
 * still returning a stable proxy for repeat access at the same path.
 */
type SnapshotCache = WeakMap<object, Map<string, unknown>>;

function pathJoin(base: string, segment: PropertyKey): string {
	return base ? `${base}.${String(segment)}` : String(segment);
}

function throwReadonlySnapshotMutation(): never {
	throw new TypeError("Cannot mutate frozen snapshot.");
}

function trackArrayElements(
	value: readonly unknown[],
	deps: Set<string>,
	path: string,
): void {
	for (let index = 0; index < value.length; index++) {
		const itemPath = pathJoin(path, index);
		deps.add(itemPath);
		const item = value[index];
		if (item !== null && typeof item === "object") {
			for (const key of Object.keys(item)) {
				deps.add(pathJoin(itemPath, key));
			}
		}
	}
}

export function readonlyTrackedSnapshot<T>(
	value: T,
	deps: Set<string>,
	path = "",
	cache: SnapshotCache = new WeakMap(),
): T {
	if (
		value === null ||
		(typeof value !== "object" && typeof value !== "function")
	) {
		return value;
	}

	// Binary buffers are atomic values: a Proxy can't wrap them (their length
	// getter/indexed access require the real receiver). Return a shallow copy so
	// the snapshot stays readonly (the source cannot be mutated through it) while
	// the dependency on the containing path is still recorded by the parent.
	if (value instanceof ArrayBuffer) {
		return value.slice(0) as T;
	}
	if (ArrayBuffer.isView(value)) {
		const view = value as ArrayBufferView & { slice?: () => ArrayBufferView };
		// Typed arrays copy via slice(); DataView has no slice(), so rebuild it.
		if (typeof view.slice === "function") return view.slice() as T;
		return new DataView(
			value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength),
		) as T;
	}

	const objectValue = value as object;
	let byPath = cache.get(objectValue);
	if (!byPath) {
		byPath = new Map();
		cache.set(objectValue, byPath);
	}
	const existing = byPath.get(path);
	if (existing) return existing as T;

	let proxy: unknown;
	proxy = new Proxy(objectValue, {
		get(target, prop, receiver) {
			if (Array.isArray(target) && prop === Symbol.iterator) {
				return function* () {
					for (let index = 0; index < target.length; index++) {
						const itemPath = pathJoin(path, index);
						deps.add(itemPath);
						yield readonlyTrackedSnapshot(target[index], deps, itemPath, cache);
					}
				};
			}

			if (target instanceof Map && prop === Symbol.iterator) {
				return () => trackedMapEntries(target, deps, path, cache);
			}

			if (target instanceof Set && prop === Symbol.iterator) {
				return () => trackedSetValues(target, deps, path, cache);
			}

			if (typeof prop === "symbol") {
				const value = Reflect.get(target, prop, receiver);
				return typeof value === "function" ? value.bind(target) : value;
			}

			const key = pathJoin(path, prop);
			deps.add(key);

			const receiverForReflect =
				target instanceof Map || target instanceof Set ? target : receiver;
			const nestedValue = Reflect.get(target, prop, receiverForReflect);

			if (target instanceof Map) {
				return trackedMapMember(target, prop, key, deps, path, cache, proxy);
			}

			if (target instanceof Set) {
				return trackedSetMember(target, prop, key, deps, path, cache, proxy);
			}

			if (target instanceof Date && typeof nestedValue === "function") {
				if (DATE_MUTATORS.has(prop)) return throwReadonlySnapshotMutation;
				return nestedValue.bind(target);
			}

			if (
				Array.isArray(target) &&
				typeof nestedValue === "function" &&
				ARRAY_SHORT_CIRCUIT_METHODS.has(prop)
			) {
				return (...args: unknown[]) => {
					trackArrayElements(target, deps, path);
					return (nestedValue as (...args: unknown[]) => unknown).apply(
						proxy,
						args,
					);
				};
			}

			if (typeof nestedValue === "function") return nestedValue;

			return readonlyTrackedSnapshot(nestedValue, deps, key, cache);
		},
		has(target, prop) {
			// `key in snapshot` depends on whether the key exists; for a computed
			// key that means depending on that node. Record the probed path.
			if (typeof prop === "string") deps.add(pathJoin(path, prop));
			return Reflect.has(target, prop);
		},
		getOwnPropertyDescriptor(target, prop) {
			// Own-key existence checks — Object.hasOwn, getOwnPropertyDescriptor,
			// hasOwnProperty — go through [[GetOwnProperty]], not `has`/`get`.
			// Record the probed key so they track the same dependency.
			if (typeof prop === "string") deps.add(pathJoin(path, prop));
			return Reflect.getOwnPropertyDescriptor(target, prop);
		},
		ownKeys(target) {
			// Enumeration (spread / Object.keys / for-in) means the formula depends
			// on the whole container, including computed children not yet present.
			markEnumerated(deps, path);
			return Reflect.ownKeys(target);
		},
		set() {
			return throwReadonlySnapshotMutation();
		},
		deleteProperty() {
			return throwReadonlySnapshotMutation();
		},
		defineProperty() {
			return throwReadonlySnapshotMutation();
		},
	});

	byPath.set(path, proxy);
	return proxy as T;
}

function trackedMapMember(
	map: Map<unknown, unknown>,
	prop: PropertyKey,
	_key: string,
	deps: Set<string>,
	path: string,
	cache: SnapshotCache,
	proxy: unknown,
): unknown {
	if (MAP_MUTATORS.has(prop)) return throwReadonlySnapshotMutation;

	if (prop === "get") {
		return (mapKey: unknown) => {
			// Record the specific entry read so an entry-level change invalidates
			// dependents, rather than collapsing every get() to the map path.
			const entryPath = pathJoin(path, String(mapKey));
			deps.add(entryPath);
			return readonlyTrackedSnapshot(map.get(mapKey), deps, entryPath, cache);
		};
	}

	if (prop === "has") {
		return (mapKey: unknown) => {
			// A has() check depends on the presence of the specific entry, so
			// record its path just like get() does.
			deps.add(pathJoin(path, String(mapKey)));
			return map.has(mapKey);
		};
	}

	if (prop === "entries")
		return () => trackedMapEntries(map, deps, path, cache);
	if (prop === "values") return () => trackedMapValues(map, deps, path, cache);
	if (prop === "keys") return () => trackedMapKeys(map, deps, path, cache);
	if (prop === "forEach") {
		return (
			callback: (value: unknown, key: unknown, map: unknown) => void,
			thisArg?: unknown,
		) => {
			let index = 0;
			for (const [mapKey, mapValue] of map) {
				callback.call(
					thisArg,
					readonlyTrackedSnapshot(
						mapValue,
						deps,
						pathJoin(pathJoin(path, index), "value"),
						cache,
					),
					readonlyTrackedSnapshot(
						mapKey,
						deps,
						pathJoin(pathJoin(path, index), "key"),
						cache,
					),
					proxy,
				);
				index++;
			}
		};
	}

	const value = Reflect.get(map, prop, map);
	return typeof value === "function" ? value.bind(map) : value;
}

function trackedSetMember(
	set: Set<unknown>,
	prop: PropertyKey,
	_key: string,
	deps: Set<string>,
	path: string,
	cache: SnapshotCache,
	proxy: unknown,
): unknown {
	if (SET_MUTATORS.has(prop)) return throwReadonlySnapshotMutation;

	if (prop === "has") {
		return (setValue: unknown) => {
			// Record membership of the specific value so adding/removing it
			// invalidates dependents.
			deps.add(pathJoin(path, String(setValue)));
			return set.has(setValue);
		};
	}

	if (prop === "entries")
		return () => trackedSetEntries(set, deps, path, cache);
	if (prop === "values" || prop === "keys") {
		return () => trackedSetValues(set, deps, path, cache);
	}
	if (prop === "forEach") {
		return (
			callback: (value: unknown, key: unknown, set: unknown) => void,
			thisArg?: unknown,
		) => {
			let index = 0;
			for (const setValue of set) {
				const itemPath = pathJoin(path, index);
				const snapshotValue = readonlyTrackedSnapshot(
					setValue,
					deps,
					itemPath,
					cache,
				);
				callback.call(thisArg, snapshotValue, snapshotValue, proxy);
				index++;
			}
		};
	}

	const value = Reflect.get(set, prop, set);
	return typeof value === "function" ? value.bind(set) : value;
}

function* trackedMapEntries(
	map: Map<unknown, unknown>,
	deps: Set<string>,
	path: string,
	cache: SnapshotCache,
): IterableIterator<[unknown, unknown]> {
	let index = 0;
	for (const [key, value] of map) {
		const itemPath = pathJoin(path, index);
		yield [
			readonlyTrackedSnapshot(key, deps, pathJoin(itemPath, "key"), cache),
			readonlyTrackedSnapshot(value, deps, pathJoin(itemPath, "value"), cache),
		];
		index++;
	}
}

function* trackedMapKeys(
	map: Map<unknown, unknown>,
	deps: Set<string>,
	path: string,
	cache: SnapshotCache,
): IterableIterator<unknown> {
	let index = 0;
	for (const key of map.keys()) {
		yield readonlyTrackedSnapshot(
			key,
			deps,
			pathJoin(pathJoin(path, index), "key"),
			cache,
		);
		index++;
	}
}

function* trackedMapValues(
	map: Map<unknown, unknown>,
	deps: Set<string>,
	path: string,
	cache: SnapshotCache,
): IterableIterator<unknown> {
	let index = 0;
	for (const value of map.values()) {
		yield readonlyTrackedSnapshot(
			value,
			deps,
			pathJoin(pathJoin(path, index), "value"),
			cache,
		);
		index++;
	}
}

function* trackedSetEntries(
	set: Set<unknown>,
	deps: Set<string>,
	path: string,
	cache: SnapshotCache,
): IterableIterator<[unknown, unknown]> {
	let index = 0;
	for (const value of set) {
		const itemPath = pathJoin(path, index);
		const snapshotValue = readonlyTrackedSnapshot(value, deps, itemPath, cache);
		yield [snapshotValue, snapshotValue];
		index++;
	}
}

function* trackedSetValues(
	set: Set<unknown>,
	deps: Set<string>,
	path: string,
	cache: SnapshotCache,
): IterableIterator<unknown> {
	let index = 0;
	for (const value of set) {
		const itemPath = pathJoin(path, index);
		yield readonlyTrackedSnapshot(value, deps, itemPath, cache);
		index++;
	}
}
