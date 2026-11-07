/**
 * Thin record helpers for the non-workflow aggregates.
 *
 * Each helper pins the `ENTITY_REGISTRY` kind string and delegates to the
 * entity mappers, so callers never repeat a literal kind or lose the managed
 * proxy identity. Budget facts use `budget_ledger` for snapshots and
 * `budget_reservation` for individual reservations.
 */

import type { AttentionObject } from "../attention/types.ts";
import type { ContextCheckpoint } from "../context/lifecycle.ts";
import type { Evidence } from "../evidence/types.ts";
import type { ProjectRule } from "../project/types.ts";
import type { ReceiptCore, ReceiptIntegrityVerification } from "../receipt/types.ts";
import type { Store } from "../service/store.ts";
import type { SaveOptions } from "../service/types.ts";
import type { BudgetReservation, BudgetSnapshot } from "../tool/types.ts";
import type { BusinessVerification } from "../verification/types.ts";
import { listEntities, loadEntity, persistEntity } from "./mappers.ts";
import type { BudgetLedgerRecord } from "./types.ts";

/* Evidence ------------------------------------------------------------- */

/** Persists one evidence item (`evidence`). */
export function persistEvidence(store: Store, evidence: Evidence, options: SaveOptions = {}): Evidence {
    return persistEntity(store, "evidence", evidence, options);
}

/** Loads one evidence item (`evidence`). */
export function loadEvidence(store: Store, id: string): Evidence | undefined {
    return loadEntity(store, "evidence", id);
}

/** Lists evidence items (`evidence`). */
export function listEvidence(store: Store): readonly Evidence[] {
    return listEntities(store, "evidence");
}

/* Receipts and verification ------------------------------------------- */

/** Persists one receipt core (`receipt`). */
export function persistReceipt(store: Store, receipt: ReceiptCore, options: SaveOptions = {}): ReceiptCore {
    return persistEntity(store, "receipt", receipt, options);
}

/** Loads one receipt core (`receipt`). */
export function loadReceipt(store: Store, id: string): ReceiptCore | undefined {
    return loadEntity(store, "receipt", id);
}

/** Persists one receipt integrity verification (`receipt_integrity`). */
export function persistReceiptIntegrity(
    store: Store,
    verification: ReceiptIntegrityVerification,
    options: SaveOptions = {},
): ReceiptIntegrityVerification {
    return persistEntity(store, "receipt_integrity", verification, options);
}

/** Loads one receipt integrity verification (`receipt_integrity`). */
export function loadReceiptIntegrity(store: Store, id: string): ReceiptIntegrityVerification | undefined {
    return loadEntity(store, "receipt_integrity", id);
}

/** Persists one business verification (`verification`). */
export function persistVerification(
    store: Store,
    verification: BusinessVerification,
    options: SaveOptions = {},
): BusinessVerification {
    return persistEntity(store, "verification", verification, options);
}

/** Loads one business verification (`verification`). */
export function loadVerification(store: Store, id: string): BusinessVerification | undefined {
    return loadEntity(store, "verification", id);
}

/* Budgets -------------------------------------------------------------- */

/**
 * Persists one budget snapshot under its ledger key (`budget_ledger`).
 * The snapshot itself is keyless, so the row carries `budgetKey` and the same
 * value in `id`; that keeps it addressable whichever key the registry declares.
 */
export function persistBudgetSnapshot(
    store: Store,
    budgetKey: string,
    snapshot: BudgetSnapshot,
    options: SaveOptions = {},
): BudgetLedgerRecord {
    return persistEntity(store, "budget_ledger", { id: budgetKey, budgetKey, ...snapshot }, options);
}

/** Loads one budget snapshot by ledger key (`budget_ledger`). */
export function loadBudgetSnapshot(store: Store, budgetKey: string): BudgetLedgerRecord | undefined {
    return loadEntity(store, "budget_ledger", budgetKey);
}

/** Persists one reservation (`budget_reservation`). */
export function persistBudgetReservation(
    store: Store,
    reservation: BudgetReservation,
    options: SaveOptions = {},
): BudgetReservation {
    return persistEntity(store, "budget_reservation", reservation, options);
}

/** Loads one reservation (`budget_reservation`). */
export function loadBudgetReservation(store: Store, id: string): BudgetReservation | undefined {
    return loadEntity(store, "budget_reservation", id);
}

/* Attention and context ------------------------------------------------ */

/** Persists one attention object (`attention`). */
export function persistAttention(store: Store, object: AttentionObject, options: SaveOptions = {}): AttentionObject {
    return persistEntity(store, "attention", object, options);
}

/** Loads one attention object (`attention`). */
export function loadAttention(store: Store, id: string): AttentionObject | undefined {
    return loadEntity(store, "attention", id);
}

/** Persists one context checkpoint (`context_checkpoint`). */
export function persistContextCheckpoint(
    store: Store,
    checkpoint: ContextCheckpoint,
    options: SaveOptions = {},
): ContextCheckpoint {
    return persistEntity(store, "context_checkpoint", checkpoint, options);
}

/** Loads one context checkpoint (`context_checkpoint`). */
export function loadContextCheckpoint(store: Store, id: string): ContextCheckpoint | undefined {
    return loadEntity(store, "context_checkpoint", id);
}

/* Project knowledge ---------------------------------------------------- */

/** Persists one versioned project rule (`project_rule`). */
export function persistProjectRule(store: Store, rule: ProjectRule, options: SaveOptions = {}): ProjectRule {
    return persistEntity(store, "project_rule", rule, options);
}

/** Loads one versioned project rule (`project_rule`). */
export function loadProjectRule(store: Store, id: string): ProjectRule | undefined {
    return loadEntity(store, "project_rule", id);
}
