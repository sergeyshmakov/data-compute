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
			// This proxy stands in for a method call such as
			// `items.reduce((sum, item) => sum + item.total, 0)`. The callback is
			// never run by the native method (there is no real array), so invoke
			// it with element proxies to record the property reads inside it.
			// The element lives one segment above the method path
			// (`items.reduce` -> element under `items`); we pass the proxy in the
			// first two argument slots so it lands on the element parameter for
			// both `(value, index)` callbacks and reduce's `(acc, value)` form.
			const dotIndex = path.lastIndexOf(".");
			const parentPath = dotIndex === -1 ? "" : path.slice(0, dotIndex);
			const elementPath = parentPath ? `${parentPath}.0` : "0";
			for (const arg of args) {
				if (typeof arg === "function") {
					const element = dryRunProxy(deps, elementPath);
					try {
						(arg as (...callbackArgs: unknown[]) => unknown)(
							element,
							element,
							0,
						);
					} catch {
						// Callback threw against the phantom proxy; reads before the
						// throw are already recorded.
					}
				}
			}
			return dryRunProxy(deps, path);
		},
		has() {
			return true;
		},
	});
}
