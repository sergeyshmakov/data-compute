function isPlainObject(item: unknown): item is Record<string, unknown> {
	return (
		item !== null &&
		typeof item === "object" &&
		!Array.isArray(item) &&
		!(item instanceof Date) &&
		!(item instanceof Set) &&
		!(item instanceof Map) &&
		// Binary buffers are atomic values, not mergeable/cloneable objects.
		!ArrayBuffer.isView(item) &&
		!(item instanceof ArrayBuffer)
	);
}

function throwFrozenSnapshotMutation(): never {
	throw new TypeError("Cannot mutate frozen snapshot.");
}

function safelyDisableMutator(value: object, method: string): void {
	const descriptor = Object.getOwnPropertyDescriptor(value, method);
	if (descriptor?.value === throwFrozenSnapshotMutation) return;

	if (descriptor && !descriptor.configurable) return;
	if (!descriptor && !Object.isExtensible(value)) return;

	try {
		Object.defineProperty(value, method, {
			value: throwFrozenSnapshotMutation,
			writable: false,
			configurable: false,
		});
	} catch {
		// Already non-extensible or otherwise not redefinable; freezing remains
		// best-effort for collection internals in that case.
	}
}

function disableMapMutators(value: Map<unknown, unknown>): void {
	for (const method of ["set", "delete", "clear"] as const) {
		safelyDisableMutator(value, method);
	}
}

function disableSetMutators(value: Set<unknown>): void {
	for (const method of ["add", "delete", "clear"] as const) {
		safelyDisableMutator(value, method);
	}
}

function cloneFallback(
	value: unknown,
	seen = new WeakMap<object, unknown>(),
): unknown {
	if (value === null || typeof value !== "object") return value;

	const objectValue = value as object;
	const existing = seen.get(objectValue);
	if (existing) return existing;

	if (value instanceof Date) {
		return new Date(value.getTime());
	}

	if (Array.isArray(value)) {
		const output: unknown[] = [];
		seen.set(value, output);
		output.length = value.length;
		for (let i = 0; i < value.length; i++) {
			if (i in value) output[i] = cloneFallback(value[i], seen);
		}
		return output;
	}

	if (value instanceof Map) {
		const output = new Map<unknown, unknown>();
		seen.set(value, output);
		for (const [key, mapValue] of value) {
			output.set(cloneFallback(key, seen), cloneFallback(mapValue, seen));
		}
		return output;
	}

	if (value instanceof Set) {
		const output = new Set<unknown>();
		seen.set(value, output);
		for (const setValue of value) {
			output.add(cloneFallback(setValue, seen));
		}
		return output;
	}

	if (!isPlainObject(value)) return value;

	const output: Record<string, unknown> = {};
	seen.set(value, output);
	for (const [key, objectValue] of Object.entries(value)) {
		output[key] = cloneFallback(objectValue, seen);
	}
	return output;
}

export function cloneForCompute<T>(value: T): T {
	if (
		value === null ||
		(typeof value !== "object" && typeof value !== "function")
	) {
		return value;
	}

	try {
		return structuredClone(value) as T;
	} catch {
		return cloneFallback(value) as T;
	}
}

function cloneArray(value: readonly unknown[]): unknown[] {
	const output: unknown[] = [];
	output.length = value.length;
	for (let i = 0; i < value.length; i++) {
		if (i in value) output[i] = cloneForCompute(value[i]);
	}
	return output;
}

export function mergeDeepPartial<T>(target: unknown, source: unknown): T {
	if (Array.isArray(target) && Array.isArray(source)) {
		const output = cloneArray(target);
		for (let i = 0; i < source.length; i++) {
			if (i in source) {
				output[i] = mergeDeepPartial(output[i], source[i]);
			}
		}
		return output as T;
	}

	if (Array.isArray(source)) {
		return cloneArray(source) as T;
	}

	if (isPlainObject(target) && isPlainObject(source)) {
		const output: Record<string, unknown> = { ...target };
		for (const key of Object.keys(source)) {
			output[key] = mergeDeepPartial(target[key], source[key]);
		}
		return output as T;
	}

	if (isPlainObject(source)) {
		return cloneForCompute(source) as T;
	}

	return cloneForCompute(source) as T;
}

export function deepFreezeSnapshot<T>(
	value: T,
	seen = new WeakSet<object>(),
): T {
	if (
		value === null ||
		(typeof value !== "object" && typeof value !== "function")
	) {
		return value;
	}

	const objectValue = value as object;
	if (seen.has(objectValue)) return value;
	seen.add(objectValue);

	// Object.freeze throws on ArrayBuffers and non-empty typed-array/DataView
	// views ("Cannot freeze array buffer views with elements"). Treat binary
	// buffers as atomic immutable values and leave them untouched.
	if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
		return value;
	}

	if (Array.isArray(value)) {
		for (const item of value) deepFreezeSnapshot(item, seen);
	} else if (value instanceof Map) {
		for (const [key, mapValue] of value) {
			deepFreezeSnapshot(key, seen);
			deepFreezeSnapshot(mapValue, seen);
		}
		disableMapMutators(value);
	} else if (value instanceof Set) {
		for (const setValue of value) deepFreezeSnapshot(setValue, seen);
		disableSetMutators(value);
	} else {
		for (const objectValue of Object.values(value as Record<string, unknown>)) {
			deepFreezeSnapshot(objectValue, seen);
		}
	}

	return Object.freeze(value);
}
