import type {
	BatchDataSourceConfig,
	DataSourceMap,
	DataSourceNode,
	DeepFormulaMap,
	RequestDataSourceConfig,
} from "../types";

export type InternalNodeType = "formula" | "batch" | "request";

type FormulaOrDepsFn = (state: unknown, root: unknown) => unknown;
type DataSourceConfig =
	| BatchDataSourceConfig<unknown, unknown>
	| RequestDataSourceConfig<unknown, unknown>;

export interface FlatNode {
	path: string;
	type: InternalNodeType;
	isEach: boolean;
	fn: FormulaOrDepsFn;
	config?: DataSourceConfig;
}

function flattenDeepMap(
	map: unknown,
	prefix: string,
	isDataSource: boolean,
): FlatNode[] {
	const nodes: FlatNode[] = [];
	if (!map) return nodes;

	if (typeof map === "function") {
		nodes.push({
			path: prefix,
			type: "formula",
			isEach: false,
			fn: map as FormulaOrDepsFn,
		});
		return nodes;
	}

	if (
		typeof map === "object" &&
		map !== null &&
		"__isDataSource" in map &&
		(map as { __isDataSource: unknown }).__isDataSource
	) {
		const ds = map as DataSourceNode<unknown, unknown, unknown>;
		nodes.push({
			path: prefix,
			type: ds.type,
			isEach: false,
			fn: ds.deps as FormulaOrDepsFn,
			config: ds.config,
		});
		return nodes;
	}

	if (
		typeof map === "object" &&
		map !== null &&
		"mapping" in map &&
		(("__isEach" in map && (map as { __isEach: unknown }).__isEach) ||
			("__isEachDataSource" in map &&
				(map as { __isEachDataSource: unknown }).__isEachDataSource))
	) {
		const itemMap = (map as { mapping: unknown }).mapping;
		const innerNodes = flattenDeepMap(
			itemMap,
			prefix ? `${prefix}.*` : "*",
			!!(map as { __isEachDataSource?: unknown }).__isEachDataSource,
		);
		for (const node of innerNodes) {
			node.isEach = true;
		}
		nodes.push(...innerNodes);
		return nodes;
	}

	if (typeof map === "object" && map !== null && !Array.isArray(map)) {
		for (const key of Object.keys(map)) {
			const nextPrefix = prefix ? `${prefix}.${key}` : key;
			nodes.push(
				...flattenDeepMap(
					(map as Record<string, unknown>)[key],
					nextPrefix,
					isDataSource,
				),
			);
		}
	}

	return nodes;
}

export function flattenGraph<Root>(
	formulas?: DeepFormulaMap<Root, Root, Root>,
	dataSources?: DataSourceMap<Root, Root, Root>,
): FlatNode[] {
	const nodes: FlatNode[] = [];
	if (formulas) {
		nodes.push(...flattenDeepMap(formulas, "", false));
	}
	if (dataSources) {
		nodes.push(...flattenDeepMap(dataSources, "", true));
	}
	return nodes;
}
