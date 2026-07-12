import { describe, expect, it } from "vitest";
import { createGraph } from "../../index.js";

describe("dry-run async array-callback rejections", () => {
	interface Root {
		items: { total: number }[];
		summary: number;
	}

	it("does not orphan a rejecting async map callback during createGraph", async () => {
		const rejections: unknown[] = [];
		const onUnhandled = (reason: unknown) => rejections.push(reason);
		process.on("unhandledRejection", onUnhandled);
		try {
			// The dry-run invokes the map callback against phantom proxies to record
			// the reads inside it. An async callback returns a promise the phantom
			// `.map` never awaits; if it rejects with no handler, Node surfaces an
			// unhandled rejection.
			createGraph<Root>({
				summary: (f) =>
					f.items.map(async () => {
						await Promise.resolve();
						throw new Error("boom");
					}).length,
			});
			// Give any orphaned rejection a turn to surface.
			await new Promise((resolve) => setTimeout(resolve, 15));
			expect(rejections).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});
});
