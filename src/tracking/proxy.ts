import { markEnumerated } from "./enumeration.js";

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
		apply(_target, _thisArg, args) {
			// This proxy stands in for an array-method call such as
			// `items.reduce((sum, item) => sum + item.total, 0)`. The callback is
			// never run by the native method (there is no real array), so invoke
			// it with element/array proxies to record the property reads inside it.
			// The element lives one segment above the method path
			// (`items.reduce` -> element under `items`).
			const dotIndex = path.lastIndexOf(".");
			const parentPath = dotIndex === -1 ? "" : path.slice(0, dotIndex);
			const methodName = dotIndex === -1 ? path : path.slice(dotIndex + 1);
			const elementPath = parentPath ? `${parentPath}.0` : "0";
			const isReducer = methodName === "reduce" || methodName === "reduceRight";

			const callbackIndex = args.findIndex((arg) => typeof arg === "function");
			if (callbackIndex !== -1) {
				const callback = args[callbackIndex] as (
					...callbackArgs: unknown[]
				) => unknown;
				const element = dryRunProxy(deps, elementPath);
				const array = dryRunProxy(deps, parentPath);
				// Dispatch by real signature so `array[index]` and reducer args land
				// correctly: (value, index, array) for iterators and
				// (acc, value, index, array) for reducers. A concrete index (0) makes
				// `array[index].prop` resolve to `<parent>.0.prop`. For iterators the
				// argument after the callback is the user thisArg; forward it.
				try {
					if (isReducer) {
						callback.call(undefined, element, element, 0, array);
					} else {
						callback.call(args[callbackIndex + 1], element, 0, array);
					}
				} catch {
					// Callback threw against the phantom proxy; reads before the throw
					// are already recorded.
				}
			}
			return dryRunProxy(deps, path);
		},
		has(_target, prop) {
			// An `in` check depends on whether the probed key exists, which for a
			// computed key means depending on that node. Record it.
			if (typeof prop === "string") {
				deps.add(path ? `${path}.${prop}` : prop);
			}
			return true;
		},
		getOwnPropertyDescriptor(target, prop) {
			// Own-key existence checks (Object.hasOwn / getOwnPropertyDescriptor)
			// go through [[GetOwnProperty]]; record the probed key too.
			if (typeof prop === "string") {
				deps.add(path ? `${path}.${prop}` : prop);
			}
			return Reflect.getOwnPropertyDescriptor(target, prop);
		},
		ownKeys(target) {
			// Enumeration (spread / Object.keys / for-in) means the formula depends
			// on the whole container, including computed children not yet present.
			markEnumerated(deps, path);
			return Reflect.ownKeys(target);
		},
	});
}
