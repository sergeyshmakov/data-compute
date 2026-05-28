import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function read(path: string): string {
	return readFileSync(path, "utf8");
}

describe("documentation guards", () => {
	it("documents the dry-run iterator accurately", () => {
		const architecture = read("ARCHITECTURE.md");
		expect(architecture).not.toMatch(/empty iterator/i);
		expect(architecture).toMatch(/two-element synthetic iterator/i);
	});

	it("does not claim plain conditionals record both branches", () => {
		const coreConcepts = read("docs/src/content/docs/guides/core-concepts.mdx");
		expect(coreConcepts).not.toMatch(/both branches are recorded/i);
		expect(coreConcepts).toMatch(/Plain conditionals record the branch/i);
	});

	it("documents cycle patches instead of changed-only patches", () => {
		const docs = [
			read("README.md"),
			read("docs/src/content/docs/guides/core-concepts.mdx"),
			read("docs/src/content/docs/guides/granular-updates.mdx"),
		].join("\n");
		expect(docs).not.toMatch(/only fields that actually changed/i);
		expect(docs).not.toMatch(/only changed fields/i);
		expect(docs).toMatch(/cycle patch/i);
	});

	it("keeps React useState examples guarded against stale async results", () => {
		const reactUseState = read(
			"docs/src/content/docs/integrations/react-usestate.mdx",
		);
		expect(reactUseState).not.toMatch(/\.then\(setState\)|then\(setState\)/);
		expect(reactUseState).toMatch(/latestRun/);
	});

	it("keeps TanStack Query examples importing used React hooks", () => {
		const tanstack = read(
			"docs/src/content/docs/integrations/tanstack-query.mdx",
		);
		expect(tanstack).toMatch(/import \{ useEffect, useState \} from "react";/);
	});

	it("keeps public type docs aligned with exported names", () => {
		const cheatsheet = read(
			"docs/src/content/docs/reference/api-cheatsheet.mdx",
		);
		const types = read("docs/src/content/docs/reference/types.mdx");

		expect(cheatsheet).not.toMatch(/type DataSource,/);
		expect(types).toMatch(/NodeSnapshot/);
		expect(types).toMatch(/TraceStep/);
		expect(types).not.toMatch(/\bPath\b/);
		expect(types).not.toMatch(/TraceEntry/);
		expect(types).not.toMatch(/NodeResult/);
		expect(types).not.toMatch(/DataSource<T, U>/);
	});

	it("keeps Zustand defaults consistent with source values", () => {
		const zustand = read("docs/src/content/docs/integrations/zustand.mdx");
		expect(zustand).toMatch(/subtotal: 20/);
		expect(zustand).toMatch(/tax: 2/);
		expect(zustand).toMatch(/total: 22/);
	});
});
