import { describe, expect, it } from "vitest";
import { readonlyTrackedSnapshot } from "../../tracking/readonly-snapshot.js";

// biome-ignore lint/suspicious/noExplicitAny: proxy access in tests
type Any = any;

describe("readonlyTrackedSnapshot immutability", () => {
	it("throws when a Date mutator is called on the snapshot", () => {
		const deps = new Set<string>();
		const snap = readonlyTrackedSnapshot({ d: new Date(0) }, deps, "") as Any;

		expect(() => snap.d.setFullYear(2000)).toThrow(/frozen snapshot/);
		expect(() => snap.d.setTime(1)).toThrow(/frozen snapshot/);
	});

	it("still allows Date reader methods", () => {
		const deps = new Set<string>();
		const snap = readonlyTrackedSnapshot(
			{ d: new Date(Date.UTC(1970, 0, 1)) },
			deps,
			"",
		) as Any;

		expect(snap.d.getUTCFullYear()).toBe(1970);
	});

	it("throws on property assignment", () => {
		const deps = new Set<string>();
		const snap = readonlyTrackedSnapshot({ x: 1 }, deps, "") as Any;
		expect(() => {
			snap.x = 2;
		}).toThrow(/frozen snapshot/);
	});
});

describe("readonlyTrackedSnapshot dependency tracking", () => {
	it("records the specific key read via Map.get", () => {
		const deps = new Set<string>();
		const m = new Map<string, number>([
			["x", 1],
			["y", 2],
		]);
		const snap = readonlyTrackedSnapshot({ m }, deps, "") as Any;

		expect(snap.m.get("x")).toBe(1);
		expect(deps.has("m.x")).toBe(true);
		expect(deps.has("m.y")).toBe(false);
	});

	it("records the specific key checked via Map.has", () => {
		const deps = new Set<string>();
		const m = new Map<string, number>([["x", 1]]);
		const snap = readonlyTrackedSnapshot({ m }, deps, "") as Any;

		expect(snap.m.has("x")).toBe(true);
		expect(snap.m.has("z")).toBe(false);
		expect(deps.has("m.x")).toBe(true);
		expect(deps.has("m.z")).toBe(true);
	});

	it("records the specific value checked via Set.has", () => {
		const deps = new Set<string>();
		const s = new Set<string>(["a"]);
		const snap = readonlyTrackedSnapshot({ s }, deps, "") as Any;

		expect(snap.s.has("a")).toBe(true);
		expect(deps.has("s.a")).toBe(true);
	});

	it("tracks aliased objects under their distinct paths", () => {
		const shared = { value: 1 };
		const deps = new Set<string>();
		const snap = readonlyTrackedSnapshot(
			{ a: shared, b: shared },
			deps,
			"",
		) as Any;

		// read the shared object through both paths
		void snap.a.value;
		void snap.b.value;

		expect(deps.has("a.value")).toBe(true);
		expect(deps.has("b.value")).toBe(true);
	});

	it("returns a stable proxy for repeat access at the same path", () => {
		const deps = new Set<string>();
		const snap = readonlyTrackedSnapshot({ nested: { x: 1 } }, deps, "") as Any;
		expect(snap.nested).toBe(snap.nested);
	});
});
