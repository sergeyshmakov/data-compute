import { describe, expect, it } from "vitest";
import { createGraph } from "../../index.js";

describe("async formula dry run during createGraph", () => {
	it("does not surface an unhandled rejection when an async formula rejects after its first await", async () => {
		const rejections: unknown[] = [];
		const handler = (reason: unknown) => rejections.push(reason);
		process.on("unhandledRejection", handler);
		try {
			interface Root {
				a: number;
				b: number;
			}
			// `b` reads nothing until after an await and then throws; the dry-run
			// call returns a rejecting promise that must not become unhandled.
			createGraph<Root>({
				b: async () => {
					await Promise.resolve();
					throw new Error("dry-run boom");
				},
				a: (f) => f.b + 1,
			});

			// Let any pending microtasks/macrotasks flush.
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(rejections).toHaveLength(0);
		} finally {
			process.off("unhandledRejection", handler);
		}
	});
});
