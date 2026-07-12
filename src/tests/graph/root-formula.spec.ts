import { describe, expect, it } from "vitest";
import { createGraph } from "../../index.js";

describe("root-level formula rejection", () => {
	it("throws when the graph definition is itself a formula", () => {
		expect(() => createGraph<number>((_f) => 42)).toThrow(
			/Root-level formulas/,
		);
	});
});
