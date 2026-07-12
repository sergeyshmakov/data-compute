import { describe, expect, it } from "vitest";
import { createGraph, request } from "../../index.js";

describe("duplicate producer rejection", () => {
	it("throws when a path is produced by both a formula and a data source", () => {
		interface Root {
			total: number;
		}
		expect(() =>
			createGraph<Root>(
				{ total: () => 1 },
				{ total: request(() => ({}), { query: async () => 2 }) },
			),
		).toThrow(/Duplicate producer/);
	});

	it("allows a formula and a data source on distinct paths", () => {
		interface Root {
			a: number;
			b: number;
		}
		expect(() =>
			createGraph<Root>(
				{ a: () => 1 },
				{ b: request(() => ({}), { query: async () => 2 }) },
			),
		).not.toThrow();
	});
});
