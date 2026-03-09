// Symbols for proxy detection (module-private)
const IS_PROXY = Symbol("data-compute:is-proxy");
const PROXY_PATH = Symbol("data-compute:path");

export function isProxy(value: unknown): value is object {
	return (
		value !== null &&
		(typeof value === "object" || typeof value === "function") &&
		(value as Record<symbol, unknown>)[IS_PROXY] === true
	);
}

/**
 * Short-circuiting Array methods that must touch every element during
 * dependency tracking so we don't miss conditional accesses.
 */
const SHORT_CIRCUIT_METHODS = new Set([
	"find",
	"findIndex",
	"findLast",
	"findLastIndex",
	"some",
	"every",
]);

/** Records access to every element (and its first-level props) of an array. */
function touchArrayElements(
	arr: unknown[],
	deps: Set<string>,
	path: string,
): void {
	for (let i = 0; i < arr.length; i++) {
		const elemPath = `${path}.${i}`;
		deps.add(elemPath);
		const elem = arr[i];
		if (elem !== null && typeof elem === "object") {
			for (const k of Object.keys(elem as object)) {
				deps.add(`${elemPath}.${k}`);
			}
		}
	}
}

/**
 * Wraps `target` in a recursive Proxy that records every property-path
 * access into `deps`. Works on real runtime data.
 */
export function trackingProxy<T extends object>(
	target: T,
	deps: Set<string>,
	path = "",
): T {
	return new Proxy(target, {
		get(obj, prop, receiver) {
			if (prop === IS_PROXY) return true;
			if (prop === PROXY_PATH) return path;

			// Pass-through symbols (iterator, toPrimitive, etc.)
			if (typeof prop === "symbol") {
				const val = Reflect.get(obj, prop, receiver);
				return typeof val === "function" ? val.bind(obj) : val;
			}

			const key = path ? `${path}.${prop}` : prop;
			deps.add(key);

			const value = Reflect.get(obj, prop, receiver);

			// Wrap short-circuiting array methods to touch all elements first
			if (
				Array.isArray(obj) &&
				typeof value === "function" &&
				SHORT_CIRCUIT_METHODS.has(prop)
			) {
				return (...args: unknown[]) => {
					touchArrayElements(obj, deps, path);
					const proxied = trackingProxy(obj, deps, path);
					// value is the array method from Reflect.get; use it directly
					return (value as (...a: unknown[]) => unknown).apply(proxied, args);
				};
			}

			if (value !== null && typeof value === "object") {
				return trackingProxy(value as object, deps, key);
			}
			return value;
		},
	});
}

/**
 * Produces a "phantom" proxy for the dry-run dependency extraction pass.
 * Every property access is recorded. No real data is needed — the proxy
 * returns safe defaults for primitive coercions and nested proxies for
 * everything else, so the formula body can execute without throwing.
 */
export function dryRunProxy(deps: Set<string>, path = ""): unknown {
	// Use Function so the proxy is both callable and an object
	const dummy: (...args: unknown[]) => unknown = function () {};
	return new Proxy(dummy, {
		get(_target, prop) {
			if (prop === IS_PROXY) return true;
			if (prop === PROXY_PATH) return path;

			if (prop === Symbol.toPrimitive) {
				return (hint: string) =>
					hint === "number" ? 0 : hint === "string" ? "" : true;
			}
			if (prop === Symbol.iterator) {
				return function* () {
					for (let i = 0; i < 2; i++) {
						const elemPath = path ? `${path}.${i}` : String(i);
						deps.add(elemPath);
						yield dryRunProxy(deps, elemPath);
					}
				};
			}
			if (typeof prop === "symbol") return undefined;

			const key = path ? `${path}.${prop}` : prop;
			deps.add(key);

			if (prop === "length") return 2;
			// Avoid being treated as thenable (causes infinite loop when awaited)
			if (prop === "then") return undefined;
			return dryRunProxy(deps, key);
		},
		apply() {
			return dryRunProxy(deps, path);
		},
		has() {
			return true;
		},
	});
}
