import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";

const REPO_URL = "https://github.com/sergeyshmakov/data-compute";

export default defineConfig({
	site: "https://sergeyshmakov.github.io/data-compute",
	base: "/data-compute",
	integrations: [
		starlight({
			title: "data-compute",
			description:
				"Typed reactive derived state for TypeScript — with async-aware nodes.",
			customCss: ["./src/styles/custom.css"],
			social: [{ icon: "github", label: "GitHub", href: REPO_URL }],
			editLink: {
				baseUrl: `${REPO_URL}/edit/main/docs/`,
			},
			lastUpdated: true,
			tableOfContents: { minHeadingLevel: 2, maxHeadingLevel: 3 },
			expressiveCode: {
				themes: ["github-dark", "github-light"],
				styleOverrides: { borderRadius: "0.375rem" },
			},
			sidebar: [
				{
					label: "Getting Started",
					items: [
						"getting-started/installation",
						"getting-started/quick-start",
					],
				},
				{
					label: "Guides",
					items: [
						"guides/core-concepts",
						"guides/snapshot-semantics",
						"guides/async-and-batching",
						"guides/granular-updates",
						"guides/deep-structures",
					],
				},
				{
					label: "Integrations",
					items: [
						"integrations/tanstack-query",
						"integrations/mobx",
						"integrations/zustand",
						"integrations/react-usestate",
					],
				},
				{
					label: "Reference",
					items: ["reference/api-cheatsheet", "reference/types"],
				},
			],
		}),
	],
});
