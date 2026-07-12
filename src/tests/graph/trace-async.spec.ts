import { describe, expect, it } from "vitest";
import { createGraph } from "../../index.js";

describe("trace() with a rejecting async formula", () => {
	it("labels the node [async] without surfacing an unhandled rejection", async () => {
		const rejections: unknown[] = [];
		const handler = (reason: unknown) => rejections.push(reason);
		process.on("unhandledRejection", handler);
		try {
			interface Root {
				a: number;
			}
			const graph = createGraph<Root>({
				a: async () => {
					await Promise.resolve();
					throw new Error("trace boom");
				},
			});

			const steps = graph.trace({});
			expect(steps.find((s) => s.node === "a")?.result).toBe("[async]");

			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(rejections).toHaveLength(0);
		} finally {
			process.off("unhandledRejection", handler);
		}
	});
});
