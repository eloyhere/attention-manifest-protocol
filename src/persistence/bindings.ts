/**
 * Domain-service bindings: durable persistence for the services that still
 * keep their authoritative state in process memory.
 *
 * Each exported `bind*` function wraps an existing in-memory service without
 * changing it. A wrapped mutation first delegates to the service; only after the
 * domain call succeeded are the resulting aggregates written through `Store` and
 * the matching `<kind>.created` / `<kind>.transitioned` fact appended, so a
 * rejected domain operation never touches storage. Entity write and event append
 * always share one `store.transaction`, which also means the binding participates
 * in a caller-owned outer transaction and rolls back with it.
 *
 * `rehydrate()` rebuilds the in-memory service from the store. Every binding
 * reports what it restored and what it had to skip in an immutable
 * {@link BindingReport}; corrupt rows are reported there instead of being thrown,
 * while operational failures (closed store, unusable transaction) still
 * propagate. {@link rehydrateAll} aggregates several bindings and is idempotent:
 * repeating it neither duplicates rows nor events.
 *
 * Rehydration notes per service:
 * - `Project` exposes no public restore API. The binding adopts the persisted
 *   rule/metadata/view maps and the environment through the same guarded
 *   private-field seam `WorkflowPersistence` uses; if that layout disappears the
 *   binding fails loudly instead of restoring a lossy state.
 * - `EvidenceLedger` exposes no restore API either. Evidence is rebuilt through
 *   `ledger.add` when the referenced `receipt` / `receipt_integrity` /
 *   `verification` rows are available, and the recorded provenance events are
 *   replayed in timestamp order; anything that cannot be rebuilt faithfully is
 *   reported as skipped.
 * - `BudgetLedger` is rebuilt through `configure` plus a `reserve` /
 *   `settle` / `release` replay, which reproduces limits, reservations and the
 *   derived settled totals.
 * - Receipt issuance/integrity/verification are pure functions, so their binding
 *   rehydrates an in-memory lookup cache. Attention operations are pure as well;
 *   its binding owns the object registry and rebuilds that list from `attention`.
 */

import type { AttentionObject, AttentionOperationOptions, AttentionRetention, AttentionUpdate, CreateAttentionInput } from "../attention/types.ts";
import { validateObject } from "../attention/validation.ts";
import type { BudgetLedger } from "../budget/ledger.ts";
import { descriptorFor } from "../entity/index.ts";
import type { EntityKind } from "../entity/types.ts";
import type { EvidenceLedger } from "../evidence/ledger.ts";
import type { AddEvidenceInput, Evidence, ProvenanceEvent } from "../evidence/types.ts";
import type { Project } from "../project/core.ts";
import { emptyEnvironment, mergeEnvironment, validateEnvironment } from "../project/environment.ts";
import type { EnvironmentPatch, ProjectEnvironment } from "../project/environment.ts";
import type { ProjectMetadata, ProjectRule, ProjectView, ProjectRuleInput, ViewKind } from "../project/types.ts";
import type { IntegrityCheckOptions, ReceiptCore, ReceiptIntegrityVerification, ReceiptLifecycle } from "../receipt/types.ts";
import type { Store } from "../service/store.ts";
import type { Budget } from "../shared.ts";
import { openSqlite } from "../sql/index.ts";
import type { SqlRow } from "../sql/types.ts";
import type { BudgetReservation, BudgetSnapshot } from "../tool/types.ts";
import type { BusinessVerification, SemanticEvaluator, VerificationOptions } from "../verification/types.ts";
import { isMissingEntity, listEntities, persistEntity, plainEntity } from "./mappers.ts";
import { loadEvidence } from "./records.ts";
import { PersistenceError } from "./types.ts";
import type { BudgetLedgerRecord, Persisted, ProjectEnvironmentRecord } from "./types.ts";

/* ------------------------------------------------------------------ */
/* Public contracts                                                   */
/* ------------------------------------------------------------------ */

/** Lifecycle phase used in a binding event kind. */
export type BindingPhase = "created" | "transitioned";

/** What one rehydration pass restored and what it had to skip. */
export interface BindingReport {
    /** Number of persisted rows accepted into the in-memory service. */
    readonly restored: number;
    /**
     * Facts that could not be restored: `kind:id` keys of corrupt or
     * unrepresentable rows and `kind:id:reason` entries for rows that parsed but
     * could not be replayed.
     */
    readonly skipped: readonly string[];
}

/**
 * One service bound to a store. `rehydrate()` loads persisted facts into the
 * in-memory service; `flush()` is an idempotent durability barrier (writes are
 * already eager, so it only re-syncs state the service exposes for syncing).
 */
export interface StoreBinding {
    /** Stable binding name, used for diagnostics only. */
    readonly name: string;
    /** Result of the most recent `rehydrate()` call. */
    readonly report: BindingReport;
    rehydrate(): void;
    flush(): void;
}

/** Accepted collection shapes for {@link rehydrateAll}. */
export type BindingCollection = StoreBinding | Iterable<StoreBinding> | Readonly<Record<string, StoreBinding>>;

/** `Project` binding. */
export interface ProjectBinding extends StoreBinding {
    readonly project: Project;
    putRule(input: ProjectRuleInput): ProjectRule;
    putMetadata(input: ProjectMetadataInput): ProjectMetadata;
    putView(input: ProjectViewInput): ProjectView;
    configureEnvironment(patch: EnvironmentPatch, options?: { readonly expectedVersion?: number }): ProjectEnvironment;
    setEnvironment(environment: ProjectEnvironment, options?: { readonly expectedVersion?: number }): ProjectEnvironment;
    rules(): readonly ProjectRule[];
    metadata(): readonly ProjectMetadata[];
    views(): readonly ProjectView[];
    environment(): ProjectEnvironment;
}

/** Input accepted by `Project.putMetadata`. */
export type ProjectMetadataInput = Parameters<Project["putMetadata"]>[0];
/** Input accepted by `Project.putView`. */
export type ProjectViewInput = Parameters<Project["putView"]>[0];

/** `EvidenceLedger` binding. */
export interface EvidenceBinding extends StoreBinding {
    readonly ledger: EvidenceLedger;
    add(input: AddEvidenceInput): Evidence;
    revoke(evidenceId: string, tenantId: string, reason: string, at: string): readonly string[];
    revoke(evidenceId: string, reason: string, at?: string): readonly string[];
    markStale(evidenceId: string, tenantId: string, reason: string, at: string): readonly string[];
    markStale(evidenceId: string, reason: string, at?: string): readonly string[];
    corroborate(evidenceId: string, byId: string, at?: string): Evidence;
}

/** Provenance module contract: `typeof import("../provenance/core.ts")`. */
export type ProvenanceOperations = typeof import("../provenance/core.ts");

/** Receipt / integrity / verification binding. */
export interface ReceiptBinding extends StoreBinding {
    readonly operations: ProvenanceOperations;
    issueReceipt(input: Parameters<ProvenanceOperations["createReceiptCore"]>[0]): ReceiptCore;
    verifyIntegrity(receipt: ReceiptCore, options: IntegrityCheckOptions): Promise<ReceiptIntegrityVerification>;
    verifyBusiness(
        receipt: ReceiptCore,
        integrity: ReceiptIntegrityVerification,
        options: VerificationOptions,
        evaluate: SemanticEvaluator,
        claims: readonly string[],
    ): Promise<BusinessVerification>;
    advance(receipt: ReceiptCore, next: ReceiptLifecycle): ReceiptCore;
    /** Module-shaped aliases, so the binding can stand in for the provenance module. */
    createReceiptCore(input: Parameters<ProvenanceOperations["createReceiptCore"]>[0]): ReceiptCore;
    verifyReceiptIntegrity(receipt: ReceiptCore, options: IntegrityCheckOptions): Promise<ReceiptIntegrityVerification>;
    verifyBusinessSemantics(
        receipt: ReceiptCore,
        integrity: ReceiptIntegrityVerification,
        options: VerificationOptions,
        evaluate: SemanticEvaluator,
        claims: readonly string[],
    ): Promise<BusinessVerification>;
    advanceReceipt(receipt: ReceiptCore, next: ReceiptLifecycle): ReceiptCore;
    receipts(): readonly ReceiptCore[];
    receipt(id: string): ReceiptCore | undefined;
    integrity(id: string): ReceiptIntegrityVerification | undefined;
    integrityForReceipt(receiptId: string): ReceiptIntegrityVerification | undefined;
    verification(id: string): BusinessVerification | undefined;
}

/** `BudgetLedger` binding. */
export interface BudgetBinding extends StoreBinding {
    readonly ledger: BudgetLedger;
    configure(key: string, limit: Budget): void;
    reserve(id: string, key: string, amount: Budget): BudgetReservation;
    settle(id: string, actual: Budget): BudgetReservation;
    release(id: string): BudgetReservation;
    snapshot(key: string): BudgetSnapshot;
    getReservation(id: string): BudgetReservation | undefined;
}

/** Attention operations module contract: `typeof import("../attention/operations.ts")`. */
export type AttentionOperations = typeof import("../attention/operations.ts");

/** Attention binding: owns the object registry the pure operations cannot hold. */
export interface AttentionBinding extends StoreBinding {
    readonly operations: AttentionOperations;
    create(input: CreateAttentionInput, now: string): AttentionObject;
    focus(object: AttentionObject, options: AttentionOperationOptions, amount?: number): AttentionObject;
    blur(object: AttentionObject, options: AttentionOperationOptions, amount?: number): AttentionObject;
    mount(object: AttentionObject, options: AttentionOperationOptions): AttentionObject;
    unmount(object: AttentionObject, options: AttentionOperationOptions): AttentionObject;
    persist(object: AttentionObject, retention: AttentionRetention, options: AttentionOperationOptions): AttentionObject;
    update(object: AttentionObject, patch: AttentionUpdate, options: AttentionOperationOptions): AttentionObject;
    get(id: string): AttentionObject | undefined;
    list(): readonly AttentionObject[];
}

/* ------------------------------------------------------------------ */
/* Shared entity helpers                                              */
/* ------------------------------------------------------------------ */

/** Any persisted payload; the binding writes across several kinds. */
type AnyPersisted = Persisted<EntityKind>;

/** A provenance event row: the domain event plus a stable identity. */
export type ProvenanceEventRecord = ProvenanceEvent & { readonly id: string };

/** A `project_environment` row extended with the domain environment revision. */
export interface ProjectEnvironmentRow extends ProjectEnvironmentRecord {
    readonly environmentVersion?: number;
}

/** A pending entity+event write. */
interface Fact {
    readonly kind: EntityKind;
    readonly entity: object;
    /** Extra event payload fields beyond `id`/`version`. */
    readonly details?: Readonly<Record<string, unknown>>;
}

type RowValidator<T> = (row: unknown) => row is T;
type IdRow = SqlRow & { readonly id: string };

/** `"<kind>.created"` / `"<kind>.transitioned"`. */
export function entityEventKind(kind: EntityKind, phase: BindingPhase): string {
    return `${kind}.${phase}`;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
    return typeof value === "string" && value.length > 0 ? value : undefined;
}

function safeVersion(value: unknown): number | undefined {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function compareText(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

/** Deterministic JSON used to compare in-memory facts with stored snapshots. */
function stableJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
    if (isRecord(value)) {
        const record = value as Readonly<Record<string, unknown>>;
        return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
    }
    return JSON.stringify(value) ?? "null";
}

/** Descriptor identity of a persisted entity, tolerating malformed payloads. */
function identityOf(kind: EntityKind, entity: unknown): string {
    if (isRecord(entity)) {
        try {
            const key = descriptorFor(kind).keyOf(entity);
            if (typeof key === "string" && key.length > 0) return key;
        } catch {
            // Fall through to the raw `id` field or the synthetic marker below.
        }
        const id = entity.id;
        if (typeof id === "string" && id.length > 0) return id;
    }
    return `<${kind}>`;
}

function versionOfEntity(entity: unknown): number {
    return isRecord(entity) ? safeVersion(entity.version) ?? 0 : 0;
}

function factKey(fact: Fact): string {
    return `${fact.kind}:${identityOf(fact.kind, fact.entity)}`;
}

function frozenReport(restored: number, skipped: readonly string[]): BindingReport {
    return Object.freeze({ restored, skipped: Object.freeze([...new Set(skipped)]) });
}

function emptyReport(): BindingReport {
    return frozenReport(0, []);
}

/**
 * True when this write creates the row.
 *
 * `Store.state` reports a managed identity for every proxy it ever handed out,
 * including a proxy whose eager load failed with `not_found`, so a preceding
 * miss must be disambiguated with another existence check before deciding the
 * event phase.
 */
function isCreation(store: Store, kind: EntityKind, id: string): boolean {
    const state = store.state(kind, id);
    if (state === "new" || state === "removed") return true;
    if (state === "detached") return false;
    try {
        store.resolve<unknown>(kind, id);
        return false;
    } catch (error) {
        if (!store.open) throw error;
        // A corrupt payload still means a row exists; only `not_found` is a creation.
        return isMissingEntity(error);
    }
}

/**
 * Writes one fact and appends `<kind>.created` or `<kind>.transitioned`.
 * Creation is decided from the store before the write, matching the mapper's
 * own `prePersist`/`preUpdate` decision.
 */
function applyFact(store: Store, fact: Fact): void {
    const id = identityOf(fact.kind, fact.entity);
    const created = isCreation(store, fact.kind, id);
    persistEntity(store, fact.kind, fact.entity as AnyPersisted);
    const version = versionOfEntity(fact.entity);
    const payload: Record<string, unknown> = { id, ...(version > 0 ? { version } : {}), ...fact.details };
    store.appendEvent(entityEventKind(fact.kind, created ? "created" : "transitioned"), payload, id);
}

/** Writes a batch of facts in one transaction; an empty batch writes nothing. */
function writeFacts(store: Store, facts: readonly Fact[]): void {
    if (facts.length === 0) return;
    store.transaction((tx) => {
        for (const fact of facts) applyFact(tx, fact);
    });
}

/* ------------------------------------------------------------------ */
/* Reads                                                              */
/* ------------------------------------------------------------------ */

function scanEntityIds(store: Store, kind: EntityKind, cause: unknown): readonly string[] {
    if (store.path === ":memory:") {
        throw new PersistenceError(
            "unsupported_store",
            `cannot recover ${kind} rows from an in-memory store: ${messageOf(cause)}`,
            { cause },
        );
    }
    try {
        const driver = openSqlite({ path: store.path, readonly: true, foreignKeys: false });
        try {
            const rows = driver.query<IdRow>({
                sql: "SELECT id FROM entities WHERE kind = ?",
                parameters: [kind],
            });
            return rows.flatMap(row => (typeof row.id === "string" && row.id.length > 0 ? [row.id] : []));
        } finally {
            driver.close();
        }
    } catch (error) {
        if (error instanceof PersistenceError) throw error;
        throw new PersistenceError("corrupt_payload", `cannot scan stored ${kind} rows: ${messageOf(error)}`, { cause: error });
    }
}

/**
 * Lists one kind and validates every payload.
 *
 * A row that parses but does not match the expected shape is reported in
 * `skipped`. A kind whose listing fails (for example one unparseable payload)
 * is recovered row by row through a side-channel id scan, so a single corrupt
 * row never hides the remaining facts.
 */
function readRows<T>(store: Store, kind: EntityKind, skipped: string[], valid: RowValidator<T>): T[] {
    try {
        const rows: T[] = [];
        for (const proxy of listEntities(store, kind)) {
            const candidate: unknown = plainEntity(proxy);
            if (valid(candidate)) rows.push(candidate);
            else skipped.push(`${kind}:${identityOf(kind, candidate)}`);
        }
        return rows;
    } catch (error) {
        if (!store.open) throw error;
        return recoverRows(store, kind, skipped, valid, error);
    }
}

function recoverRows<T>(
    store: Store,
    kind: EntityKind,
    skipped: string[],
    valid: RowValidator<T>,
    cause: unknown,
): T[] {
    const ids = scanEntityIds(store, kind, cause);
    const rows: T[] = [];
    for (const id of ids) {
        let candidate: unknown;
        try {
            candidate = plainEntity(store.resolve<unknown>(kind, id));
        } catch (error) {
            if (!store.open) throw error;
            skipped.push(`${kind}:${id}`);
            continue;
        }
        if (valid(candidate)) rows.push(candidate);
        else skipped.push(`${kind}:${id}`);
    }
    return rows;
}

/* ------------------------------------------------------------------ */
/* Project binding                                                    */
/* ------------------------------------------------------------------ */

const VIEW_KINDS: readonly ViewKind[] = Object.freeze(["er", "sequence", "flow", "venn", "architecture", "mindmap"]);

function isProjectRuleRow(row: unknown): row is ProjectRule {
    return isRecord(row)
        && text(row.id) !== undefined
        && text(row.tenantId) !== undefined
        && text(row.rootId) !== undefined
        && text(row.text) !== undefined
        && safeVersion(row.version) !== undefined
        && text(row.hash) !== undefined
        && typeof row.updatedAt === "string" && Number.isFinite(Date.parse(row.updatedAt));
}

function isProjectMetadataRow(row: unknown): row is ProjectMetadata {
    return isRecord(row)
        && text(row.path) !== undefined
        && text(row.tenantId) !== undefined
        && text(row.rootId) !== undefined
        && safeVersion(row.version) !== undefined
        && typeof row.updatedAt === "string" && Number.isFinite(Date.parse(row.updatedAt))
        && Array.isArray(row.tags) && row.tags.every(item => typeof item === "string")
        && Array.isArray(row.ruleIds) && row.ruleIds.every(item => typeof item === "string");
}

function isProjectViewRow(row: unknown): row is ProjectView {
    return isRecord(row)
        && typeof row.kind === "string" && (VIEW_KINDS as readonly string[]).includes(row.kind)
        && text(row.tenantId) !== undefined
        && text(row.rootId) !== undefined
        && "projection" in row
        && safeVersion(row.version) !== undefined
        && typeof row.stale === "boolean"
        && typeof row.updatedAt === "string" && Number.isFinite(Date.parse(row.updatedAt))
        && Array.isArray(row.sourceRuleIds) && row.sourceRuleIds.every(item => typeof item === "string")
        && Array.isArray(row.sourceVersions);
}

function isProjectEnvironmentRow(row: unknown): row is ProjectEnvironmentRow {
    if (!isRecord(row) || text(row.tenantId) === undefined || text(row.rootId) === undefined) return false;
    if (row.environmentVersion !== undefined && safeVersion(row.environmentVersion) === undefined) return false;
    try {
        validateEnvironment(row as unknown as ProjectEnvironment);
        return true;
    } catch {
        return false;
    }
}

interface MapLike {
    readonly clear?: unknown;
    readonly put?: unknown;
}

function isMapLike(candidate: unknown): boolean {
    if (typeof candidate !== "object" || candidate === null) return false;
    const map = candidate as MapLike;
    return typeof map.clear === "function" && typeof map.put === "function";
}

function replaceMapContents<K, V>(candidate: unknown, entries: readonly (readonly [K, V])[]): void {
    const map = candidate as MapLike;
    const clear = map.clear;
    const put = map.put;
    if (typeof clear !== "function" || typeof put !== "function") {
        throw new Error("project state cannot be adopted: internal maps are unavailable");
    }
    Reflect.apply(clear, candidate, []);
    for (const [key, value] of entries) Reflect.apply(put, candidate, [key, value]);
}

class ProjectBindingImpl implements ProjectBinding {
    readonly store: Store;
    readonly project: Project;
    readonly name = "project";
    private state: BindingReport = emptyReport();
    /** Stable snapshots last written successfully, keyed by `kind:id`. */
    private readonly persisted = new Map<string, string>();

    constructor(store: Store, project: Project) {
        this.store = store;
        this.project = project;
    }

    get report(): BindingReport {
        return this.state;
    }

    putRule(input: ProjectRuleInput): ProjectRule {
        const rule = this.project.putRule(input);
        this.sync();
        return rule;
    }

    putMetadata(input: ProjectMetadataInput): ProjectMetadata {
        const metadata = this.project.putMetadata(input);
        this.sync();
        return metadata;
    }

    putView(input: ProjectViewInput): ProjectView {
        const view = this.project.putView(input);
        this.sync();
        return view;
    }

    configureEnvironment(patch: EnvironmentPatch, options: { readonly expectedVersion?: number } = {}): ProjectEnvironment {
        const environment = this.project.configureEnvironment(patch, options);
        this.sync();
        return environment;
    }

    setEnvironment(environment: ProjectEnvironment, options: { readonly expectedVersion?: number } = {}): ProjectEnvironment {
        const next = this.project.setEnvironment(environment, options);
        this.sync();
        return next;
    }

    rules(): readonly ProjectRule[] {
        return this.project.listRules();
    }

    metadata(): readonly ProjectMetadata[] {
        return this.project.listMetadata();
    }

    views(): readonly ProjectView[] {
        return this.project.listViews();
    }

    environment(): ProjectEnvironment {
        return this.project.environment;
    }

    /**
     * Loads project rows, adopts them into the `Project` and remembers the
     * adopted snapshots so a subsequent operation only writes real changes.
     */
    rehydrate(): void {
        const skipped: string[] = [];
        const tenantId = this.project.tenantId;
        const rootId = this.project.rootId;
        const rules = readRows(this.store, "project_rule", skipped, isProjectRuleRow)
            .filter(rule => rule.tenantId === tenantId && rule.rootId === rootId)
            .sort((left, right) => compareText(left.id, right.id));
        const metadata = readRows(this.store, "project_metadata", skipped, isProjectMetadataRow)
            .filter(item => item.tenantId === tenantId && item.rootId === rootId)
            .sort((left, right) => compareText(left.path, right.path));
        const views = readRows(this.store, "project_view", skipped, isProjectViewRow)
            .filter(view => view.tenantId === tenantId && view.rootId === rootId)
            .sort((left, right) => compareText(left.kind, right.kind));
        const environments = readRows(this.store, "project_environment", skipped, isProjectEnvironmentRow)
            .filter(row => row.tenantId === tenantId && row.rootId === rootId);
        const environmentRow = environments[0];

        if (rules.length > 0 || metadata.length > 0 || views.length > 0) {
            this.adoptMaps(rules, metadata, views);
        }
        if (environmentRow !== undefined) this.adoptEnvironment(environmentRow);

        this.remember(rules, metadata, views, environmentRow);
        const restored = rules.length + metadata.length + views.length + (environmentRow === undefined ? 0 : 1);
        this.state = frozenReport(restored, skipped);
    }

    /** Re-syncs the current project state; normally a no-op after eager writes. */
    flush(): void {
        this.sync();
    }

    private adoptMaps(
        rules: readonly ProjectRule[],
        metadata: readonly ProjectMetadata[],
        views: readonly ProjectView[],
    ): void {
        const record = this.project as unknown as Record<string, unknown>;
        if (!isMapLike(record.rules) || !isMapLike(record.metadata) || !isMapLike(record.views)) {
            throw new Error(
                "project state cannot be adopted: the Project instance no longer exposes its rule/metadata/view maps",
            );
        }
        replaceMapContents(record.rules, rules.map(rule => [rule.id, rule] as const));
        replaceMapContents(record.metadata, metadata.map(item => [item.path, item] as const));
        replaceMapContents(record.views, views.map(view => [view.kind, view] as const));
    }

    private adoptEnvironment(row: ProjectEnvironmentRow): void {
        const record = this.project as unknown as Record<string, unknown>;
        if (!("environmentValue" in record) || !("environmentVersionValue" in record)) {
            throw new Error(
                "project state cannot be adopted: the Project instance no longer exposes its environment state",
            );
        }
        const environment = mergeEnvironment(emptyEnvironment(), {
            variables: row.variables,
            paths: row.paths,
            dependencies: row.dependencies,
        });
        record.environmentValue = environment;
        record.environmentVersionValue = safeVersion(row.environmentVersion) ?? 0;
    }

    private remember(
        rules: readonly ProjectRule[],
        metadata: readonly ProjectMetadata[],
        views: readonly ProjectView[],
        environmentRow: ProjectEnvironmentRow | undefined,
    ): void {
        this.persisted.clear();
        for (const rule of rules) {
            const fact: Fact = { kind: "project_rule", entity: rule };
            this.persisted.set(factKey(fact), stableJson(rule));
        }
        for (const item of metadata) {
            const fact: Fact = { kind: "project_metadata", entity: item };
            this.persisted.set(factKey(fact), stableJson(item));
        }
        for (const view of views) {
            const fact: Fact = { kind: "project_view", entity: view };
            this.persisted.set(factKey(fact), stableJson(view));
        }
        if (environmentRow !== undefined) {
            const fact = this.environmentFact();
            if (fact !== undefined) this.persisted.set(factKey(fact), stableJson(fact.entity));
        }
    }

    /** Persists every project fact whose current value differs from the last write. */
    private sync(): void {
        const changed = this.currentFacts().filter(fact => this.persisted.get(factKey(fact)) !== stableJson(fact.entity));
        if (changed.length === 0) return;
        writeFacts(this.store, changed);
        for (const fact of changed) this.persisted.set(factKey(fact), stableJson(fact.entity));
    }

    private currentFacts(): readonly Fact[] {
        const facts: Fact[] = [];
        for (const rule of this.project.listRules()) facts.push({ kind: "project_rule", entity: rule });
        for (const metadata of this.project.listMetadata()) facts.push({ kind: "project_metadata", entity: metadata });
        for (const view of this.project.listViews()) facts.push({ kind: "project_view", entity: view });
        const environment = this.environmentFact();
        if (environment !== undefined) facts.push(environment);
        return facts;
    }

    private environmentFact(): Fact | undefined {
        const environment = this.project.environment;
        const version = this.project.environmentVersion;
        const empty = Object.keys(environment.variables).length === 0
            && environment.paths.length === 0
            && environment.dependencies.length === 0;
        if (version === 0 && empty) return undefined;
        const row: ProjectEnvironmentRow = {
            tenantId: this.project.tenantId,
            rootId: this.project.rootId,
            variables: environment.variables,
            paths: environment.paths,
            dependencies: environment.dependencies,
            environmentVersion: version,
        };
        return { kind: "project_environment", entity: row, details: { environmentVersion: version } };
    }
}

/**
 * Binds project knowledge to the store: every successful `putRule`,
 * `putMetadata`, `putView`, `configureEnvironment` (and `setEnvironment`) is
 * mirrored into `project_rule` / `project_metadata` / `project_view` /
 * `project_environment`, including view invalidation caused by a rule update.
 */
export function bindProject(store: Store, project: Project): ProjectBinding {
    return new ProjectBindingImpl(store, project);
}

/* ------------------------------------------------------------------ */
/* Evidence binding                                                   */
/* ------------------------------------------------------------------ */

function isEvidenceRow(row: unknown): row is Evidence {
    return isRecord(row)
        && text(row.id) !== undefined
        && text(row.tenantId) !== undefined
        && text(row.claim) !== undefined
        && text(row.receiptId) !== undefined
        && text(row.verificationId) !== undefined
        && text(row.integrityVerificationId) !== undefined
        && text(row.criteriaVersion) !== undefined
        && text(row.environmentVersion) !== undefined
        && text(row.createdAt) !== undefined
        && typeof row.status === "string"
        && Array.isArray(row.dependsOn);
}

function isReceiptRow(row: unknown): row is ReceiptCore {
    return isRecord(row)
        && text(row.id) !== undefined
        && isRecord(row.invocation)
        && isRecord(row.observation)
        && text(row.issuedAt) !== undefined
        && text(row.payloadDigest) !== undefined
        && text(row.hashAlgorithm) !== undefined;
}

function isIntegrityRow(row: unknown): row is ReceiptIntegrityVerification {
    return isRecord(row)
        && text(row.id) !== undefined
        && text(row.receiptId) !== undefined
        && (row.status === "integrity_verified" || row.status === "integrity_rejected")
        && typeof row.digestValid === "boolean"
        && text(row.verifier) !== undefined
        && text(row.verifiedAt) !== undefined
        && Array.isArray(row.reasons);
}

function isBusinessVerificationRow(row: unknown): row is BusinessVerification {
    return isRecord(row)
        && text(row.id) !== undefined
        && text(row.receiptId) !== undefined
        && text(row.observationId) !== undefined
        && (row.status === "semantic_verified" || row.status === "semantic_rejected" || row.status === "inconclusive")
        && Array.isArray(row.claims)
        && text(row.criteriaVersion) !== undefined
        && text(row.verifier) !== undefined
        && text(row.verifiedAt) !== undefined;
}

function isProvenanceRow(row: unknown): row is ProvenanceEventRecord {
    if (!isRecord(row) || text(row.id) === undefined || text(row.at) === undefined) return false;
    const type = row.type;
    if (typeof type !== "string") return false;
    switch (type) {
        case "evidence_added":
            return text(row.evidenceId) !== undefined;
        case "evidence_revoked":
        case "evidence_staled":
            return text(row.evidenceId) !== undefined && typeof row.reason === "string";
        case "evidence_corroborated":
            return text(row.evidenceId) !== undefined && text(row.byId) !== undefined;
        case "dependency_invalidated":
            return text(row.sourceId) !== undefined && text(row.dependentId) !== undefined;
        default:
            return false;
    }
}

function provenanceTarget(event: ProvenanceEvent): string {
    return event.type === "dependency_invalidated" ? event.sourceId : event.evidenceId;
}

function provenanceTime(event: ProvenanceEvent): number {
    const parsed = Date.parse(event.at);
    return Number.isFinite(parsed) ? parsed : 0;
}

function compareProvenance(left: ProvenanceEventRecord, right: ProvenanceEventRecord): number {
    return (provenanceTime(left) - provenanceTime(right)) || compareText(left.id, right.id);
}

function evidenceInvolves(event: ProvenanceEvent, ids: ReadonlySet<string>): boolean {
    switch (event.type) {
        case "dependency_invalidated":
            return ids.has(event.sourceId) || ids.has(event.dependentId);
        case "evidence_corroborated":
            return ids.has(event.evidenceId) || ids.has(event.byId);
        default:
            return ids.has(event.evidenceId);
    }
}

function toAddInput(
    row: Evidence,
    receipt: ReceiptCore,
    integrity: ReceiptIntegrityVerification,
    verification: BusinessVerification,
): AddEvidenceInput {
    return {
        id: row.id,
        tenantId: row.tenantId,
        claim: row.claim,
        polarity: row.polarity,
        receipt,
        integrity,
        verification,
        criteriaVersion: row.criteriaVersion,
        environmentVersion: row.environmentVersion,
        createdAt: row.createdAt,
        dependsOn: row.dependsOn,
        ...(row.expiresAt === undefined ? {} : { expiresAt: row.expiresAt }),
        ...(row.level === undefined ? {} : { level: row.level }),
        ...(row.parentId === undefined ? {} : { parentId: row.parentId }),
        ...(row.agentId === undefined ? {} : { agentId: row.agentId }),
        ...(row.cooperationId === undefined ? {} : { cooperationId: row.cooperationId }),
        ...(row.sessionId === undefined ? {} : { sessionId: row.sessionId }),
        ...(row.turnId === undefined ? {} : { turnId: row.turnId }),
        ...(row.source === undefined ? {} : { source: row.source }),
        ...(row.corroborationIds === undefined ? {} : { corroborationIds: row.corroborationIds }),
        ...(row.consumedBy === undefined ? {} : { consumedBy: row.consumedBy }),
        ...(row.supersededBy === undefined ? {} : { supersededBy: row.supersededBy }),
        ...(row.freshnessScore === undefined ? {} : { freshnessScore: row.freshnessScore }),
    };
}

class EvidenceBindingImpl implements EvidenceBinding {
    readonly store: Store;
    readonly ledger: EvidenceLedger;
    readonly name = "evidence";
    private state: BindingReport = emptyReport();
    /** Evidence identity to tenant, needed to re-read propagated dependents. */
    private readonly tenants = new Map<string, string>();
    /** Evidence snapshots already persisted, keyed by `evidence:<id>`. */
    private readonly persisted = new Map<string, string>();
    private eventOrdinal = 0;

    constructor(store: Store, ledger: EvidenceLedger) {
        this.store = store;
        this.ledger = ledger;
    }

    get report(): BindingReport {
        return this.state;
    }

    add(input: AddEvidenceInput): Evidence {
        const before = this.ledger.auditEvents().length;
        const evidence = this.ledger.add(input);
        this.writeEvidence([{ kind: "evidence", entity: evidence, details: { status: evidence.status } }],
            this.ledger.auditEvents().slice(before));
        this.tenants.set(evidence.id, evidence.tenantId);
        return evidence;
    }

    revoke(evidenceId: string, tenantId: string, reason: string, at: string): readonly string[];
    revoke(evidenceId: string, reason: string, at?: string): readonly string[];
    revoke(evidenceId: string, tenantIdOrReason: string, reasonOrAt?: string, at?: string): readonly string[] {
        const before = this.ledger.auditEvents().length;
        const order = at !== undefined && reasonOrAt !== undefined
            ? this.ledger.revoke(evidenceId, tenantIdOrReason, reasonOrAt, at)
            : this.ledger.revoke(evidenceId, tenantIdOrReason, reasonOrAt);
        const tenantId = at !== undefined && reasonOrAt !== undefined ? tenantIdOrReason : this.tenantOf(evidenceId);
        this.persistAffected(order, tenantId, this.ledger.auditEvents().slice(before));
        return order;
    }

    markStale(evidenceId: string, tenantId: string, reason: string, at: string): readonly string[];
    markStale(evidenceId: string, reason: string, at?: string): readonly string[];
    markStale(evidenceId: string, tenantIdOrReason: string, reasonOrAt?: string, at?: string): readonly string[] {
        const before = this.ledger.auditEvents().length;
        const order = at !== undefined && reasonOrAt !== undefined
            ? this.ledger.markStale(evidenceId, tenantIdOrReason, reasonOrAt, at)
            : this.ledger.markStale(evidenceId, tenantIdOrReason, reasonOrAt);
        const tenantId = at !== undefined && reasonOrAt !== undefined ? tenantIdOrReason : this.tenantOf(evidenceId);
        this.persistAffected(order, tenantId, this.ledger.auditEvents().slice(before));
        return order;
    }

    corroborate(evidenceId: string, byId: string, at?: string): Evidence {
        const before = this.ledger.auditEvents().length;
        const evidence = this.ledger.corroborate(evidenceId, byId, at);
        this.persistAffected([evidence.id], evidence.tenantId, this.ledger.auditEvents().slice(before));
        return evidence;
    }

    /**
     * Rebuilds the ledger through `add` (when the receipt chain is stored) and
     * replays provenance events for the rebuilt items. Unreconstructable rows are
     * reported as skipped; a second call over an unchanged store adds nothing.
     */
    rehydrate(): void {
        const skipped: string[] = [];
        const evidenceRows = readRows(this.store, "evidence", skipped, isEvidenceRow);
        const receipts = new Map(readRows(this.store, "receipt", skipped, isReceiptRow).map(row => [row.id, row]));
        const integrities = new Map(readRows(this.store, "receipt_integrity", skipped, isIntegrityRow).map(row => [row.id, row]));
        const verifications = new Map(readRows(this.store, "verification", skipped, isBusinessVerificationRow).map(row => [row.id, row]));
        const provenance = readRows(this.store, "provenance_event", skipped, isProvenanceRow)
            .sort(compareProvenance);
        // Keep future event ids strictly after the stored ones so a restarted
        // binding never reuses an identity that already exists.
        this.eventOrdinal = Math.max(this.eventOrdinal, provenance.length);

        const rows = [...evidenceRows].sort((left, right) => compareText(left.createdAt, right.createdAt) || compareText(left.id, right.id));
        const tenantById = new Map(rows.map(row => [row.id, row.tenantId]));
        const statusById = new Map(rows.map(row => [row.id, row.status]));
        const rebuilt = new Set<string>();
        const pending = [...rows];
        let progress = true;
        while (pending.length > 0 && progress) {
            progress = false;
            for (let index = 0; index < pending.length;) {
                const row = pending[index]!;
                if (this.ledger.get(row.id, row.tenantId) !== undefined) {
                    pending.splice(index, 1);
                    progress = true;
                    continue;
                }
                const dependency = row.dependsOn.find(id => this.ledger.get(id, row.tenantId) === undefined);
                if (dependency !== undefined && pending.some(other => other.id === dependency)) {
                    index += 1;
                    continue;
                }
                const failure = this.rebuild(row, receipts, integrities, verifications);
                if (failure !== undefined) {
                    skipped.push(`evidence:${row.id}:${failure}`);
                } else {
                    rebuilt.add(row.id);
                    progress = true;
                }
                pending.splice(index, 1);
            }
        }
        for (const row of pending) skipped.push(`evidence:${row.id}:dependency_unresolved`);

        if (rebuilt.size > 0) {
            for (const event of provenance) {
                if (!evidenceInvolves(event, rebuilt)) continue;
                try {
                    this.replay(event, tenantById, statusById);
                } catch (error) {
                    skipped.push(`provenance_event:${event.id}:${messageOf(error)}`);
                }
            }
        }

        let restored = 0;
        for (const row of rows) {
            this.tenants.set(row.id, row.tenantId);
            const current = this.ledger.get(row.id, row.tenantId);
            if (current === undefined) continue;
            restored += 1;
            this.persisted.set(`evidence:${row.id}`, stableJson(current));
        }
        this.state = frozenReport(restored, skipped);
    }

    /** Writes are eager; evidence has no buffered state, so flush is a barrier. */
    flush(): void {
        // Nothing to do: every accepted mutation was already written.
    }

    private rebuild(
        row: Evidence,
        receipts: ReadonlyMap<string, ReceiptCore>,
        integrities: ReadonlyMap<string, ReceiptIntegrityVerification>,
        verifications: ReadonlyMap<string, BusinessVerification>,
    ): string | undefined {
        const receipt = receipts.get(row.receiptId);
        if (receipt === undefined) return "receipt_missing";
        const integrity = integrities.get(row.integrityVerificationId);
        if (integrity === undefined) return "integrity_missing";
        const verification = verifications.get(row.verificationId);
        if (verification === undefined) return "verification_missing";
        try {
            this.ledger.add(toAddInput(row, receipt, integrity, verification));
            return undefined;
        } catch (error) {
            return messageOf(error);
        }
    }

    /**
     * Re-applies one recorded invalidation. Events already implied by the stored
     * final status (a propagated dependent, or a repeat) are left alone.
     */
    private replay(
        event: ProvenanceEventRecord,
        tenantById: ReadonlyMap<string, string>,
        statusById: ReadonlyMap<string, string>,
    ): void {
        switch (event.type) {
            case "evidence_added":
            case "dependency_invalidated":
                return;
            case "evidence_revoked":
            case "evidence_staled": {
                const tenantId = tenantById.get(event.evidenceId);
                if (tenantId === undefined) return;
                const current = this.ledger.get(event.evidenceId, tenantId);
                if (current === undefined || current.status === statusById.get(event.evidenceId)) return;
                if (event.type === "evidence_revoked") this.ledger.revoke(event.evidenceId, tenantId, event.reason, event.at);
                else this.ledger.markStale(event.evidenceId, tenantId, event.reason, event.at);
                return;
            }
            case "evidence_corroborated": {
                const tenantId = tenantById.get(event.evidenceId);
                if (tenantId === undefined) return;
                const current = this.ledger.get(event.evidenceId, tenantId);
                if (current === undefined || current.status === statusById.get(event.evidenceId)) return;
                this.ledger.corroborate(event.evidenceId, event.byId, event.at);
                return;
            }
        }
    }

    private changedEvidence(order: readonly string[], tenantHint: string | undefined): Evidence[] {
        const affected: Evidence[] = [];
        for (const id of order) {
            const evidence = this.evidenceOf(id, tenantHint);
            if (evidence === undefined) continue;
            if (this.persisted.get(`evidence:${id}`) === stableJson(evidence)) continue;
            affected.push(evidence);
        }
        return affected;
    }

    private persistAffected(order: readonly string[], tenantHint: string | undefined, events: readonly ProvenanceEvent[]): void {
        const facts: Fact[] = this.changedEvidence(order, tenantHint)
            .map(evidence => ({ kind: "evidence" as const, entity: evidence, details: { status: evidence.status } }));
        this.writeEvidence(facts, events);
    }

    private writeEvidence(facts: readonly Fact[], events: readonly ProvenanceEvent[]): void {
        if (facts.length === 0 && events.length === 0) return;
        const rows = this.provenanceRows(events);
        this.store.transaction((tx) => {
            for (const fact of facts) applyFact(tx, fact);
            for (const row of rows) {
                persistEntity(tx, "provenance_event", row as unknown as Persisted<"provenance_event">);
            }
        });
        for (const fact of facts) this.persisted.set(factKey(fact), stableJson(fact.entity));
        this.eventOrdinal += events.length;
    }

    private provenanceRows(events: readonly ProvenanceEvent[]): ProvenanceEventRecord[] {
        return events.map((event, index) => ({
            ...event,
            id: `provenance:${event.type}:${provenanceTarget(event)}:${event.at}:${this.eventOrdinal + index}`,
        })) as ProvenanceEventRecord[];
    }

    private tenantOf(evidenceId: string): string | undefined {
        const known = this.tenants.get(evidenceId);
        if (known !== undefined) return known;
        try {
            const stored = loadEvidence(this.store, evidenceId);
            if (stored === undefined) return undefined;
            const evidence = plainEntity(stored);
            this.tenants.set(evidence.id, evidence.tenantId);
            return evidence.tenantId;
        } catch (error) {
            if (!this.store.open) throw error;
            return undefined;
        }
    }

    private evidenceOf(evidenceId: string, tenantHint?: string): Evidence | undefined {
        if (tenantHint !== undefined) {
            const direct = this.ledger.get(evidenceId, tenantHint);
            if (direct !== undefined) return direct;
        }
        const known = this.tenants.get(evidenceId);
        if (known !== undefined) {
            const found = this.ledger.get(evidenceId, known);
            if (found !== undefined) return found;
        }
        for (const tenantId of new Set(this.tenants.values())) {
            const found = this.ledger.get(evidenceId, tenantId);
            if (found !== undefined) return found;
        }
        return undefined;
    }
}

/**
 * Binds the evidence ledger: `add`, `revoke`, `corroborate` and `markStale`
 * write the affected `evidence` rows and the ledger's `provenance_event` facts in
 * one transaction, including dependents invalidated by propagation.
 */
export function bindEvidence(store: Store, ledger: EvidenceLedger): EvidenceBinding {
    return new EvidenceBindingImpl(store, ledger);
}

/* ------------------------------------------------------------------ */
/* Receipt binding                                                    */
/* ------------------------------------------------------------------ */

class ReceiptBindingImpl implements ReceiptBinding {
    readonly store: Store;
    readonly operations: ProvenanceOperations;
    readonly name = "receipts";
    private state: BindingReport = emptyReport();
    private readonly receiptCache = new Map<string, ReceiptCore>();
    private readonly integrityCache = new Map<string, ReceiptIntegrityVerification>();
    private readonly integrityByReceipt = new Map<string, ReceiptIntegrityVerification>();
    private readonly verificationCache = new Map<string, BusinessVerification>();

    constructor(store: Store, operations: ProvenanceOperations) {
        this.store = store;
        this.operations = operations;
    }

    get report(): BindingReport {
        return this.state;
    }

    issueReceipt(input: Parameters<ProvenanceOperations["createReceiptCore"]>[0]): ReceiptCore {
        const receipt = this.operations.createReceiptCore(input);
        this.rememberReceipt(receipt);
        return receipt;
    }

    async verifyIntegrity(receipt: ReceiptCore, options: IntegrityCheckOptions): Promise<ReceiptIntegrityVerification> {
        const integrity = await this.operations.verifyReceiptIntegrity(receipt, options);
        writeFacts(this.store, [{
            kind: "receipt_integrity",
            entity: integrity,
            details: { receiptId: integrity.receiptId, status: integrity.status },
        }]);
        this.integrityCache.set(integrity.id, integrity);
        this.integrityByReceipt.set(integrity.receiptId, integrity);
        return integrity;
    }

    async verifyBusiness(
        receipt: ReceiptCore,
        integrity: ReceiptIntegrityVerification,
        options: VerificationOptions,
        evaluate: SemanticEvaluator,
        claims: readonly string[],
    ): Promise<BusinessVerification> {
        const verification = await this.operations.verifyBusinessSemantics(receipt, integrity, options, evaluate, claims);
        writeFacts(this.store, [{
            kind: "verification",
            entity: verification,
            details: { receiptId: verification.receiptId, status: verification.status },
        }]);
        this.verificationCache.set(verification.id, verification);
        return verification;
    }

    advance(receipt: ReceiptCore, next: ReceiptLifecycle): ReceiptCore {
        const advanced = this.operations.advanceReceipt(receipt, next);
        writeFacts(this.store, [{
            kind: "receipt",
            entity: advanced,
            details: { lifecycle: advanced.lifecycle ?? "issued" },
        }]);
        this.receiptCache.set(advanced.id, advanced);
        return advanced;
    }

    createReceiptCore(input: Parameters<ProvenanceOperations["createReceiptCore"]>[0]): ReceiptCore {
        return this.issueReceipt(input);
    }

    verifyReceiptIntegrity(receipt: ReceiptCore, options: IntegrityCheckOptions): Promise<ReceiptIntegrityVerification> {
        return this.verifyIntegrity(receipt, options);
    }

    verifyBusinessSemantics(
        receipt: ReceiptCore,
        integrity: ReceiptIntegrityVerification,
        options: VerificationOptions,
        evaluate: SemanticEvaluator,
        claims: readonly string[],
    ): Promise<BusinessVerification> {
        return this.verifyBusiness(receipt, integrity, options, evaluate, claims);
    }

    advanceReceipt(receipt: ReceiptCore, next: ReceiptLifecycle): ReceiptCore {
        return this.advance(receipt, next);
    }

    receipts(): readonly ReceiptCore[] {
        return Object.freeze([...this.receiptCache.values()].sort((left, right) => compareText(left.id, right.id)));
    }

    receipt(id: string): ReceiptCore | undefined {
        return this.receiptCache.get(id);
    }

    integrity(id: string): ReceiptIntegrityVerification | undefined {
        return this.integrityCache.get(id);
    }

    integrityForReceipt(receiptId: string): ReceiptIntegrityVerification | undefined {
        return this.integrityByReceipt.get(receiptId);
    }

    verification(id: string): BusinessVerification | undefined {
        return this.verificationCache.get(id);
    }

    rehydrate(): void {
        const skipped: string[] = [];
        const receipts = readRows(this.store, "receipt", skipped, isReceiptRow)
            .sort((left, right) => compareText(left.id, right.id));
        const integrities = readRows(this.store, "receipt_integrity", skipped, isIntegrityRow)
            .sort((left, right) => compareText(left.id, right.id));
        const verifications = readRows(this.store, "verification", skipped, isBusinessVerificationRow)
            .sort((left, right) => compareText(left.id, right.id));

        this.receiptCache.clear();
        this.integrityCache.clear();
        this.integrityByReceipt.clear();
        this.verificationCache.clear();
        for (const receipt of receipts) this.receiptCache.set(receipt.id, receipt);
        for (const integrity of integrities) {
            this.integrityCache.set(integrity.id, integrity);
            this.integrityByReceipt.set(integrity.receiptId, integrity);
        }
        for (const verification of verifications) this.verificationCache.set(verification.id, verification);

        this.state = frozenReport(receipts.length + integrities.length + verifications.length, skipped);
    }

    /** Writes are eager; the cache is the only in-memory state and is rebuilt above. */
    flush(): void {
        // Nothing to do: every issued/verified fact was already written.
    }

    private rememberReceipt(receipt: ReceiptCore): void {
        writeFacts(this.store, [{
            kind: "receipt",
            entity: receipt,
            details: { lifecycle: receipt.lifecycle ?? "issued" },
        }]);
        this.receiptCache.set(receipt.id, receipt);
    }
}

/**
 * Binds receipt provenance: issuance, integrity verification, business
 * verification and lifecycle advances write `receipt`, `receipt_integrity` and
 * `verification` rows with `<kind>.created` / `<kind>.transitioned` events.
 */
export function bindReceipts(store: Store, operations: ProvenanceOperations): ReceiptBinding {
    return new ReceiptBindingImpl(store, operations);
}

/* ------------------------------------------------------------------ */
/* Budget binding                                                     */
/* ------------------------------------------------------------------ */

function isBudgetLedgerRow(row: unknown): row is BudgetLedgerRecord {
    return isRecord(row)
        && text(row.budgetKey) !== undefined
        && isRecord(row.limit)
        && isRecord(row.settled)
        && isRecord(row.reserved);
}

function isBudgetReservationRow(row: unknown): row is BudgetReservation {
    if (!isRecord(row) || text(row.id) === undefined || text(row.budgetKey) === undefined || !isRecord(row.amount)) return false;
    if (row.state !== "reserved" && row.state !== "settled" && row.state !== "released") return false;
    return row.actual === undefined || isRecord(row.actual);
}

class BudgetBindingImpl implements BudgetBinding {
    readonly store: Store;
    readonly ledger: BudgetLedger;
    readonly name = "budget";
    private state: BindingReport = emptyReport();

    constructor(store: Store, ledger: BudgetLedger) {
        this.store = store;
        this.ledger = ledger;
    }

    get report(): BindingReport {
        return this.state;
    }

    configure(key: string, limit: Budget): void {
        this.ledger.configure(key, limit);
        this.writeLedger(key, {});
    }

    reserve(id: string, key: string, amount: Budget): BudgetReservation {
        const reservation = this.ledger.reserve(id, key, amount);
        this.writeReservation(reservation, { amount: reservation.amount });
        return reservation;
    }

    settle(id: string, actual: Budget): BudgetReservation {
        const reservation = this.ledger.settle(id, actual);
        this.writeReservation(reservation, { actual: reservation.actual });
        return reservation;
    }

    release(id: string): BudgetReservation {
        const reservation = this.ledger.release(id);
        this.writeReservation(reservation, {});
        return reservation;
    }

    snapshot(key: string): BudgetSnapshot {
        return this.ledger.snapshot(key);
    }

    getReservation(id: string): BudgetReservation | undefined {
        return this.ledger.getReservation(id);
    }

    /**
     * Restores limits through `configure`, then replays every reservation through
     * `reserve` and its recorded `settle`/`release`; the settled totals are
     * derived by that replay and verified against the stored ledger snapshot.
     */
    rehydrate(): void {
        const skipped: string[] = [];
        const ledgers = readRows(this.store, "budget_ledger", skipped, isBudgetLedgerRow)
            .sort((left, right) => compareText(left.budgetKey, right.budgetKey));
        const reservations = readRows(this.store, "budget_reservation", skipped, isBudgetReservationRow)
            .sort((left, right) => compareText(left.id, right.id));
        let restored = 0;

        for (const row of ledgers) {
            try {
                this.ledger.configure(row.budgetKey, row.limit);
                restored += 1;
            } catch (error) {
                skipped.push(`budget_ledger:${row.budgetKey}:${messageOf(error)}`);
            }
        }
        for (const row of reservations) {
            if (this.ledger.getReservation(row.id) !== undefined) {
                // A repeated rehydrate must not replay an existing reservation.
                restored += 1;
                continue;
            }
            try {
                this.ledger.reserve(row.id, row.budgetKey, row.amount);
                if (row.state === "settled") this.ledger.settle(row.id, row.actual ?? row.amount);
                else if (row.state === "released") this.ledger.release(row.id);
                restored += 1;
            } catch (error) {
                skipped.push(`budget_reservation:${row.id}:${messageOf(error)}`);
            }
        }
        for (const row of ledgers) {
            try {
                const snapshot = this.ledger.snapshot(row.budgetKey);
                if (stableJson(snapshot.settled) !== stableJson(row.settled)
                    || stableJson(snapshot.reserved) !== stableJson(row.reserved)) {
                    skipped.push(`budget_ledger:${row.budgetKey}:totals_mismatch`);
                }
            } catch {
                // An unconfigured ledger was already reported above.
            }
        }
        this.state = frozenReport(restored, skipped);
    }

    /** Writes are eager; budget state has no buffered writes to flush. */
    flush(): void {
        // Nothing to do: configure/reserve/settle/release were already written.
    }

    private writeReservation(reservation: BudgetReservation, details: Readonly<Record<string, unknown>>): void {
        writeFacts(this.store, [
            { kind: "budget_reservation", entity: reservation, details: { budgetKey: reservation.budgetKey, state: reservation.state, ...details } },
            this.ledgerFact(reservation.budgetKey, { reservationId: reservation.id }),
        ]);
    }

    private writeLedger(key: string, details: Readonly<Record<string, unknown>>): void {
        writeFacts(this.store, [this.ledgerFact(key, details)]);
    }

    private ledgerFact(key: string, details: Readonly<Record<string, unknown>>): Fact {
        const snapshot = this.ledger.snapshot(key);
        const record: BudgetLedgerRecord = { id: key, budgetKey: key, ...snapshot };
        return { kind: "budget_ledger", entity: record, details: { budgetKey: key, ...details } };
    }
}

/**
 * Binds budget accounting: `configure` writes the `budget_ledger` snapshot and
 * every `reserve` / `settle` / `release` writes both its `budget_reservation`
 * and the updated ledger snapshot in one transaction.
 */
export function bindBudget(store: Store, ledger: BudgetLedger): BudgetBinding {
    return new BudgetBindingImpl(store, ledger);
}

/* ------------------------------------------------------------------ */
/* Attention binding                                                  */
/* ------------------------------------------------------------------ */

function isAttentionRow(row: unknown): row is AttentionObject {
    if (!isRecord(row) || text(row.id) === undefined) return false;
    try {
        validateObject(row as unknown as AttentionObject);
        return true;
    } catch {
        return false;
    }
}

class AttentionBindingImpl implements AttentionBinding {
    readonly store: Store;
    readonly operations: AttentionOperations;
    readonly name = "attention";
    private state: BindingReport = emptyReport();
    private readonly objects = new Map<string, AttentionObject>();

    constructor(store: Store, operations: AttentionOperations) {
        this.store = store;
        this.operations = operations;
    }

    get report(): BindingReport {
        return this.state;
    }

    create(input: CreateAttentionInput, now: string): AttentionObject {
        const object = this.operations.createAttention(input, now);
        this.write(object, { from: 0, to: object.version });
        this.objects.set(object.id, object);
        return object;
    }

    focus(object: AttentionObject, options: AttentionOperationOptions, amount?: number): AttentionObject {
        return this.revise(object, this.operations.focus(object, options, amount));
    }

    blur(object: AttentionObject, options: AttentionOperationOptions, amount?: number): AttentionObject {
        return this.revise(object, this.operations.blur(object, options, amount));
    }

    mount(object: AttentionObject, options: AttentionOperationOptions): AttentionObject {
        return this.revise(object, this.operations.mount(object, options));
    }

    unmount(object: AttentionObject, options: AttentionOperationOptions): AttentionObject {
        return this.revise(object, this.operations.unmount(object, options));
    }

    persist(object: AttentionObject, retention: AttentionRetention, options: AttentionOperationOptions): AttentionObject {
        return this.revise(object, this.operations.persist(object, retention, options));
    }

    update(object: AttentionObject, patch: AttentionUpdate, options: AttentionOperationOptions): AttentionObject {
        return this.revise(object, this.operations.update(object, patch, options));
    }

    get(id: string): AttentionObject | undefined {
        return this.objects.get(id);
    }

    list(): readonly AttentionObject[] {
        return Object.freeze([...this.objects.values()]);
    }

    /** Rebuilds the object registry from every persisted `attention` row. */
    rehydrate(): void {
        const skipped: string[] = [];
        const rows = readRows(this.store, "attention", skipped, isAttentionRow)
            .sort((left, right) => compareText(left.createdAt ?? "", right.createdAt ?? "") || compareText(left.id, right.id));
        this.objects.clear();
        for (const row of rows) this.objects.set(row.id, row);
        this.state = frozenReport(rows.length, skipped);
    }

    /** Writes are eager; attention has no buffered writes to flush. */
    flush(): void {
        // Nothing to do: every accepted operation was already written.
    }

    private revise(previous: AttentionObject, next: AttentionObject): AttentionObject {
        this.write(next, { from: previous.version, to: next.version });
        this.objects.set(next.id, next);
        return next;
    }

    private write(object: AttentionObject, details: Readonly<Record<string, unknown>>): void {
        writeFacts(this.store, [{ kind: "attention", entity: object, details }]);
    }
}

/**
 * Binds attention operations: create, focus, blur, mount, unmount, retention and
 * content updates write the `attention` aggregate; `rehydrate` rebuilds the
 * object list the pure operations cannot hold themselves.
 */
export function bindAttention(store: Store, operations: AttentionOperations): AttentionBinding {
    return new AttentionBindingImpl(store, operations);
}

/* ------------------------------------------------------------------ */
/* Aggregate rehydration                                              */
/* ------------------------------------------------------------------ */

function isStoreBinding(value: unknown): value is StoreBinding {
    if (typeof value !== "object" || value === null) return false;
    const candidate = value as Partial<StoreBinding>;
    return typeof candidate.rehydrate === "function" && typeof candidate.flush === "function";
}

function normalizeBindings(bindings: BindingCollection): StoreBinding[] {
    if (isStoreBinding(bindings)) return [bindings];
    if (typeof (bindings as Iterable<StoreBinding>)[Symbol.iterator] === "function") {
        return [...(bindings as Iterable<StoreBinding>)].filter(isStoreBinding);
    }
    return Object.values(bindings as Readonly<Record<string, StoreBinding>>).filter(isStoreBinding);
}

/**
 * Rehydrates every supplied binding and returns the aggregated, immutable
 * report. Order is the caller's; repeated calls are idempotent because each
 * binding replaces (or skips already-restored) state rather than appending.
 */
export function rehydrateAll(store: Store, bindings: BindingCollection): BindingReport {
    if (!store.open) throw new Error("store is closed");
    let restored = 0;
    const skipped: string[] = [];
    for (const binding of normalizeBindings(bindings)) {
        binding.rehydrate();
        restored += binding.report.restored;
        skipped.push(...binding.report.skipped);
    }
    return frozenReport(restored, skipped);
}
