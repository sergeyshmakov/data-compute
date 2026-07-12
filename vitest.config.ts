import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["src/tests/**/*.spec.ts"],
		globals: true,
		typecheck: {
			include: ["src/tests/**/*.test-d.ts"],
		},
	},
});
