import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function read(path: string): string {
	return readFileSync(path, "utf8");
}

describe("release configuration", () => {
	it("uses npm trusted publishing in the publish workflow", () => {
		const workflow = read(".github/workflows/publish.yml");
		expect(workflow).toMatch(/id-token:\s*write/);
		expect(workflow).toMatch(/NPM_CONFIG_PROVENANCE:\s*true/);
		expect(workflow).not.toMatch(/\bNPM_TOKEN\b|\bNODE_AUTH_TOKEN\b/);
	});

	it("bootstraps the first release as 0.1.0", () => {
		const workflow = read(".github/workflows/publish.yml");
		// The bootstrap step must refuse any first-release version other than 0.1.0.
		expect(workflow).toMatch(/"\$\{VERSION\}"\s*!=\s*"0\.1\.0"/);
		expect(workflow).toMatch(/first release must be 0\.1\.0/);
	});

	it("keeps Dependabot npm dependency-type filters under allow", () => {
		const dependabot = read(".github/dependabot.yml");
		const npmBlocks = dependabot
			.split(/\n\s*-\s+package-ecosystem:/)
			.slice(1)
			.filter((block) => block.trimStart().startsWith('"npm"'));

		expect(npmBlocks).toHaveLength(2);
		for (const block of npmBlocks) {
			expect(block).toMatch(/allow:\s*\n\s+- dependency-type: "direct"/);
		}
		expect(dependabot).not.toMatch(/^ {4}dependency-type:/m);
	});
});
