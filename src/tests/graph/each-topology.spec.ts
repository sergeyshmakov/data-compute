import { describe, expect, it } from "vitest";
import { createGraph, each } from "../../index.js";

describe("each template working topology", () => {
	it("unions every item's producers so ordering reflects all of them", async () => {
		interface Root {
			items: number[];
			pLate: number;
			pMid: number;
		}
		// Neither producer is a static dep (the dry run takes the `0` branch), and
		// each is read by exactly one item. If the template's working edges were
		// replaced per item instead of unioned, the last item to finish would drop
		// the others' producers, leaving them ordered after `items` and thrashing
		// retries until the limit. Unioning keeps every producer ordered first.
		const graph = createGraph<Root>({
			items: each((item: number, root) =>
				item === 0 ? root.pLate : item === 1 ? root.pMid : 0,
			),
			pLate: () => 111,
			pMid: () => 222,
		});

		const r = await graph.compute({ items: [0, 1, 2] });
		expect(r.items).toEqual([111, 222, 0]);
	});
});
