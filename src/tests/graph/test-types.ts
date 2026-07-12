/** Shared Root types for graph tests to satisfy strict TypeScript. */

export interface SyncChainRoot {
	quantity: number;
	unitPrice: number;
	taxRate: number;
	discount: number;
	subtotal: number;
	tax: number;
	total: number;
}

export interface AbcRoot {
	a: number;
	b: number;
	c: number;
}

export interface DelayedRoot {
	value: number;
	delayed: { before: number; after: number };
}

export interface SourceComputedRoot {
	source: number;
	computed: number;
}

export interface ApiResultRoot {
	apiResult: { data: number };
}

export interface ApiOkRoot {
	apiResult: { ok: boolean };
}

export interface DiscountRoot {
	isPremium: boolean;
	premiumDiscount: number;
	standardDiscount: number;
	discount: number;
}

export interface BonusRoot {
	userTier: string;
	goldDiscount: number;
	silverDiscount: number;
	bonus: number;
}

export interface SumRoot {
	a: number;
	b: number;
	sum: number;
}

export interface SlowRoot {
	slow: string;
}

export interface FastSlowRoot {
	fast: string;
	slow?: string;
}

export interface AbRoot {
	a: number;
	b: number;
}

export interface AbErrorRoot {
	a: number;
	b: number;
}

export interface CombinedRoot {
	combined: number;
}

export interface OptRoot {
	opt?: undefined;
}

export interface NestedArrRoot {
	nested: { a: number; b: { c: number } };
	arr: number[];
}

export interface ItemsTotalRoot {
	items: { price: number }[];
	total: number;
}

export interface AsyncDerivedRoot {
	asyncData: number;
	derived: number;
}

export interface TotalRoot {
	a: number;
	b: number;
	total: number;
}

export interface DepsRoot {
	quantity: number;
	unitPrice: number;
	taxRate: number;
	subtotal: number;
	tax: number;
	total: number;
}

export interface IntrospectionRoot {
	source: number;
	computed: number;
}

export interface TraceAbcRoot {
	a: number;
	b: number;
	c: number;
}

export interface TraceXRoot {
	x: number;
	a: number;
}

export interface TraceSumRoot {
	a: number;
	b: number;
	sum: number;
}

export interface TraceAsyncRoot {
	asyncVal: number;
}
