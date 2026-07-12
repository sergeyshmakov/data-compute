import type {
	CreateGraph,
	DataSourceMap,
	DeepFormulaMap,
	GraphOptions,
} from "../types.js";
import { ComputeGraph } from "./compute-graph.js";

export const createGraph: CreateGraph = ((...args: unknown[]) => {
	// Overload 2: createGraph<Root>() → builder
	if (args.length === 0) {
		return (
			// biome-ignore lint/suspicious/noExplicitAny: generic boundaries
			formulas: DeepFormulaMap<any, any, any>,
			// biome-ignore lint/suspicious/noExplicitAny: generic boundaries
			dataSources?: DataSourceMap<any, any, any>,
			// biome-ignore lint/suspicious/noExplicitAny: generic boundaries
			options?: GraphOptions<any>,
		) => {
			return new ComputeGraph(formulas, dataSources, options);
		};
	}
	// Overload 1: createGraph(formulas, dataSources?, options?)
	// biome-ignore lint/suspicious/noExplicitAny: generic boundaries
	const formulas = args[0] as DeepFormulaMap<any, any, any>;
	// biome-ignore lint/suspicious/noExplicitAny: generic boundaries
	const dataSources = args[1] as DataSourceMap<any, any, any> | undefined;
	// biome-ignore lint/suspicious/noExplicitAny: generic boundaries
	const options = args[2] as GraphOptions<any> | undefined;

	return new ComputeGraph(formulas, dataSources, options);
}) as CreateGraph;
