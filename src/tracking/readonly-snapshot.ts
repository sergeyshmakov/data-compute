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
	cache = new WeakMap<object, unknown>(),
): T {
	if (
		value === null ||
		(typeof value !== "object" && typeof value !== "function")
	) {
		return value;
	}

	const objectValue = value as object;
	const existing = cache.get(objectValue);
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

	cache.set(objectValue, proxy);
	return proxy as T;
}

function trackedMapMember(
	map: Map<unknown, unknown>,
	prop: PropertyKey,
	key: string,
	deps: Set<string>,
	path: string,
	cache: WeakMap<object, unknown>,
	proxy: unknown,
): unknown {
	if (MAP_MUTATORS.has(prop)) return throwReadonlySnapshotMutation;

	if (prop === "get") {
		return (mapKey: unknown) =>
			readonlyTrackedSnapshot(map.get(mapKey), deps, key, cache);
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
	cache: WeakMap<object, unknown>,
	proxy: unknown,
): unknown {
	if (SET_MUTATORS.has(prop)) return throwReadonlySnapshotMutation;

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
	cache: WeakMap<object, unknown>,
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
	cache: WeakMap<object, unknown>,
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
	cache: WeakMap<object, unknown>,
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
	cache: WeakMap<object, unknown>,
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
	cache: WeakMap<object, unknown>,
): IterableIterator<unknown> {
	let index = 0;
	for (const value of set) {
		const itemPath = pathJoin(path, index);
		yield readonlyTrackedSnapshot(value, deps, itemPath, cache);
		index++;
	}
}
