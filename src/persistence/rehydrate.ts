/**
 * Rehydration entry point.
 *
 * `rehydrate` validates the append-only event journal order, rebuilds the
 * workflow snapshot from the store and returns the {@link RestoreReport}. A
 * supplied `workflow` is the writer that receives the restored state; when it is
 * omitted a throwaway kernel is restored only to validate the stored facts.
 */

import type { EventRecord } from "../entity/types.ts";
import type { Store } from "../service/store.ts";
import { WorkflowStore } from "../workflow/store.ts";
import { PersistenceError } from "./types.ts";
import type { PersistenceOptions, RestoreReport } from "./types.ts";
import { WorkflowPersistence, validateEventOrder } from "./workflow.ts";

/** Options for {@link rehydrate}. */
export interface RehydrateOptions extends PersistenceOptions {
    /** Set to false to skip the strict event-sequence guard. Defaults to true. */
    readonly validateEventOrder?: boolean;
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * Restores persisted workflow facts into `workflow` (or into a throwaway kernel
 * when omitted) and reports how many entities/events were restored.
 */
export function rehydrate(
    store: Store,
    workflow?: WorkflowStore,
    options: RehydrateOptions = {},
): RestoreReport {
    if (options.validateEventOrder !== false) {
        let events: readonly EventRecord[];
        try {
            events = store.events();
        } catch (error) {
            throw new PersistenceError(
                "corrupt_payload",
                `cannot read stored events: ${messageOf(error)}`,
                { cause: error },
            );
        }
        validateEventOrder(events);
    }
    const target = workflow ?? new WorkflowStore(options.now ?? (() => new Date().toISOString()));
    const persistence = new WorkflowPersistence({
        store,
        workflow: target,
        ...(options.now === undefined ? {} : { now: options.now }),
    });
    return persistence.restoreAll();
}
