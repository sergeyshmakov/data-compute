import { describe, expect, it, vi } from "vitest";
import { createGraph, request } from "../../index.js";

describe("data source deps returning a snapshot container", () => {
	interface Root {
		raw: string;
		filters: { normalized: string };
		echo: string;
	}

	it("waits for the container's computed children and sends a plain request", async () => {
		const query = vi.fn(async (req: { normalized: string }) => {
			// A leaked readonly tracking proxy throws on mutation; a materialized
			// plain object accepts (and here reverts) a probe write.
			const probe = req as Record<string, unknown>;
			probe.probed = true;
			delete probe.probed;
			return req.normalized;
		});

		const graph = createGraph<Root>(
			{
				filters: { normalized: (f) => f.raw.toUpperCase() },
			},
			{
				// Returns the whole `filters` container directly, never enumerating
				// `.normalized`. The engine must still record a dependency on the
				// computed child so the query runs after it resolves.
				echo: request((f) => f.filters, { query }),
			},
		);

		const result = await graph.compute({ raw: "hello" });

		expect(result.echo).toBe("HELLO");
		expect(query).toHaveBeenCalledTimes(1);
		expect(query).toHaveBeenCalledWith({ normalized: "HELLO" });
	});
});
