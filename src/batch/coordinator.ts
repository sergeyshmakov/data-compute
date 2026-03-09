import type {
	BatchDataSourceConfig,
	BatchEntry,
	BatchFailure,
	BatchSuccess,
} from "../types";

interface PendingRequest {
	id: string;
	request: unknown;
	resolve: (value: unknown) => void;
	reject: (error: unknown) => void;
}

/**
 * Collects `batchRequest` resolutions within a microtask and flushes them as a
 * single batched query per data source. Supports deduplication via `dedupeKey`.
 * Uses config.query (a function) as Map key; typed as object to avoid variance.
 */
export class BatchCoordinator {
	private pending = new Map<object, PendingRequest[]>();
	private configs = new Map<object, BatchDataSourceConfig<unknown, unknown>>();

	private flushScheduled = false;
	private nextId = 0;
	private controllers = new Set<AbortController>();

	submit<Req, Res>(
		config: BatchDataSourceConfig<Req, Res>,
		request: Req,
	): Promise<Res> {
		return new Promise((resolve, reject) => {
			const id = String(++this.nextId);
			const key = config.query as object;
			let list = this.pending.get(key);
			if (!list) {
				list = [];
				this.pending.set(key, list);
				this.configs.set(
					key,
					config as BatchDataSourceConfig<unknown, unknown>,
				);
			}
			list.push({
				id,
				request,
				resolve: resolve as (value: unknown) => void,
				reject,
			});
			this.scheduleFlush();
		});
	}

	abort(): void {
		for (const controller of this.controllers) {
			controller.abort();
		}
		this.controllers.clear();
	}

	private scheduleFlush(): void {
		if (this.flushScheduled) return;
		this.flushScheduled = true;
		queueMicrotask(() => this.flush());
	}

	private async flush(): Promise<void> {
		this.flushScheduled = false;
		const snapshotPending = new Map(this.pending);
		const snapshotConfigs = new Map(this.configs);

		this.pending.clear();
		this.configs.clear();

		for (const [queryFn, entries] of snapshotPending) {
			const config = snapshotConfigs.get(queryFn);
			if (config) await this.flushChannel(config, entries);
		}
	}

	private async flushChannel(
		config: BatchDataSourceConfig<unknown, unknown>,
		entries: PendingRequest[],
	): Promise<void> {
		const batchEntries: BatchEntry<unknown>[] = [];
		const receivers = new Map<string, PendingRequest[]>(); // batchId → original entries

		if (config.dedupeKey) {
			const seen = new Map<string, string>(); // dedupeKey → batch entry id
			for (const e of entries) {
				const dk = config.dedupeKey(e.request);
				const existingId = seen.get(dk);
				if (existingId !== undefined) {
					const arr = receivers.get(existingId);
					if (arr) arr.push(e);
				} else {
					seen.set(dk, e.id);
					batchEntries.push({ id: e.id, request: e.request });
					receivers.set(e.id, [e]);
				}
			}
		} else {
			for (const e of entries) {
				batchEntries.push({ id: e.id, request: e.request });
				receivers.set(e.id, [e]);
			}
		}

		const controller = new AbortController();
		this.controllers.add(controller);

		try {
			const outcomes = await config.query(batchEntries, {
				signal: controller.signal,
			});
			for (const outcome of outcomes) {
				const pending = receivers.get(outcome.id);
				if (!pending) continue;
				const isSuccess = "response" in outcome;
				for (const p of pending) {
					isSuccess
						? p.resolve((outcome as BatchSuccess<unknown>).response)
						: p.reject((outcome as BatchFailure).error);
				}
			}
		} catch (err) {
			for (const e of entries) e.reject(err);
		}
	}
}
