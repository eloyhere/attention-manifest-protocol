import { assertJsonValue } from "../../semantic/jsonValue.ts";
import { catalogKey } from "../entity/catalog.ts";
import type { CatalogEntryEntity, CatalogRecord, CatalogRelationEntity, CatalogSyncState } from "../entity/catalog.ts";
import type { CatalogRepository, CatalogSyncLease, CatalogSyncRecovery } from "../repository/catalogRepository.ts";
export type { CatalogSyncLease, CatalogSyncRecovery } from "../repository/catalogRepository.ts";
import type { MutationResult } from "../sql/sql.ts";
import { Service } from "./service.ts";
import { CatalogPublicationRepository } from "../repository/catalogPublication.ts";
import type { CatalogPublication } from "../repository/catalogPublication.ts";

export type { CatalogRecord, CatalogSyncState } from "../entity/catalog.ts";

const nonempty = (value: unknown, label: string): void => {
    if (typeof value !== "string" || value.trim().length === 0) {
        throw new TypeError(`${label} must be a nonempty string`);
    }
};

/** Validate before encoding and copy plain data so toJSON cannot rewrite it. */
const encodeJson = (value: unknown, label: string): string => {
    assertJsonValue(value, label);
    const copy = (item: unknown): unknown => {
        if (item === null || typeof item !== "object") {
            return item;
        }
        if (Array.isArray(item)) {
            return item.map(copy);
        }
        const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
        for (const key of Object.keys(item)) {
            result[key] = copy((item as Record<string, unknown>)[key]);
        }
        return result;
    };
    return JSON.stringify(copy(value));
};

const stringArray = (value: unknown, label: string): string[] => {
    if (!Array.isArray(value)) {
        throw new TypeError(`${label} must be an array of strings`);
    }
    assertJsonValue(value, label);
    if (!value.every((item) => typeof item === "string")) {
        throw new TypeError(`${label} must be an array of strings`);
    }
    return [...value];
};

const parseStringArray = (value: string, label: string): string[] => {
    const parsed: unknown = JSON.parse(value);
    return stringArray(parsed, label);
};

const parsePayload = (value: string): Record<string, unknown> => {
    const parsed: unknown = JSON.parse(value);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new TypeError("payload JSON must decode to an object");
    }
    assertJsonValue(parsed, "payload");
    return parsed as Record<string, unknown>;
};

/** Policy and JSON conversion for catalog persistence; SQL stays in repositories. */
export class CatalogService extends Service<CatalogEntryEntity, string, CatalogRepository> {
    private readonly changeHandlers = new Set<() => void>();

    constructor(repository: CatalogRepository) {
        super(repository, "catalog entry");
    }

    publication(namespace: string): CatalogPublication {
        nonempty(namespace, "namespace");
        return new CatalogPublicationRepository(this.repository.connection).read(namespace);
    }

    beginPublication(namespace: string): number {
        nonempty(namespace, "namespace");
        if (this.inTransaction) throw new Error("commit the catalog transaction before synchronization");
        return new CatalogPublicationRepository(this.repository.connection).begin(namespace);
    }

    publishSnapshot(namespace: string, epoch: number, generation: number, index: string, digest: string): boolean {
        nonempty(namespace, "namespace");
        nonempty(index, "index");
        nonempty(digest, "digest");
        if (!Number.isSafeInteger(epoch) || epoch < 1 || !Number.isSafeInteger(generation) || generation < 1) throw new TypeError("invalid publication version");
        if (this.inTransaction) throw new Error("commit the catalog transaction before publishing a snapshot");
        return new CatalogPublicationRepository(this.repository.connection).publish(namespace, epoch, generation, index, digest);
    }

    /** Subscribe a concrete cache; no module-level or implicit shared cache. */
    onChange(handler: () => void): () => void {
        this.changeHandlers.add(handler);
        return () => { this.changeHandlers.delete(handler); };
    }

    private changed(): void {
        for (const handler of this.changeHandlers) {
            handler();
        }
    }

    replaceSnapshot(namespace: string, records: readonly CatalogRecord[]): number {
        nonempty(namespace, "namespace");
        if (!Array.isArray(records)) {
            throw new TypeError("records must be an array");
        }
        const entries: CatalogEntryEntity[] = [];
        const relations: CatalogRelationEntity[] = [];
        const keys = new Set<string>();
        const updatedAt = new Date().toISOString();
        // Prepare every row before opening the transaction or deleting old data.
        for (const record of records) {
            if (record === null || typeof record !== "object" || Array.isArray(record)) {
                throw new TypeError("catalog record must be an object");
            }
            nonempty(record.id, "id");
            nonempty(record.kind, "kind");
            nonempty(record.name, "name");
            if (typeof record.summary !== "string") {
                throw new TypeError("summary must be a string");
            }
            for (const field of ["projectId", "revision", "sourceUri"] as const) {
                if (record[field] !== undefined && typeof record[field] !== "string") {
                    throw new TypeError(`${field} must be a string`);
                }
            }
            if (record.payload === null || typeof record.payload !== "object" || Array.isArray(record.payload)) {
                throw new TypeError("payload must be a JSON object");
            }
            assertJsonValue(record.payload, "payload");
            const tags = record.tags === undefined ? [] : stringArray(record.tags, "tags");
            const searchTerms = record.searchTerms === undefined ? [] : stringArray(record.searchTerms, "searchTerms");
            const key = catalogKey(namespace, record.kind, record.id);
            if (keys.has(key)) {
                throw new TypeError(`duplicate catalog record: ${key}`);
            }
            keys.add(key);
            if (record.relations !== undefined) {
                if (!Array.isArray(record.relations)) {
                    throw new TypeError("relations must be an array");
                }
                assertJsonValue(record.relations, "relations");
                const relationKeys = new Set<string>();
                for (const relation of record.relations) {
                    if (relation === null || typeof relation !== "object" || Array.isArray(relation)) {
                        throw new TypeError("relation must be an object");
                    }
                    nonempty(relation.relation, "relation");
                    nonempty(relation.targetId, "targetId");
                    const relationKey = JSON.stringify([key, relation.relation, relation.targetId]);
                    if (relationKeys.has(relationKey)) {
                        throw new TypeError(`duplicate catalog relation: ${relationKey}`);
                    }
                    relationKeys.add(relationKey);
                    relations.push({ key: relationKey, namespace, source_key: key, relation: relation.relation, target_id: relation.targetId });
                }
            }
            entries.push({
                key, namespace, id: record.id, kind: record.kind, name: record.name, summary: record.summary,
                project_id: record.projectId ?? null,
                revision: record.revision ?? null,
                source_uri: record.sourceUri ?? null,
                tags_json: JSON.stringify(tags),
                search_terms_json: JSON.stringify(searchTerms),
                payload_json: encodeJson(record.payload, "payload"),
                updated_at: updatedAt,
            });
        }
        const generation = this.repository.replaceSnapshot(namespace, entries, relations);
        this.changed();
        return generation;
    }

    read(namespace: string, kind: string, id: string): CatalogRecord | undefined {
        this.validateIdentity(namespace, kind, id);
        const entry = this.findById(catalogKey(namespace, kind, id));
        return entry === undefined ? undefined : this.recordFromEntry(entry);
    }

    list(namespace: string): CatalogRecord[] {
        nonempty(namespace, "namespace");
        const relations = new Map<string, { relation: string; targetId: string }[]>();
        for (const row of this.repository.relationsInNamespace(namespace)) {
            const group = relations.get(row.source_key) ?? [];
            group.push({ relation: row.relation, targetId: row.target_id });
            relations.set(row.source_key, group);
        }
        return this.repository.listNamespace(namespace).map((row) => this.recordFromEntry(row, relations.get(row.key) ?? []));
    }

    relations(namespace: string, kind: string, id: string): { relation: string; targetId: string }[] {
        this.validateIdentity(namespace, kind, id);
        return this.repository.relationsFor(namespace, catalogKey(namespace, kind, id)).map((row) => ({ relation: row.relation, targetId: row.target_id }));
    }

    state(namespace: string): CatalogSyncState {
        nonempty(namespace, "namespace");
        return this.repository.state(namespace);
    }

    /** Cache reads bypass resident data while the caller owns a transaction. */
    get inTransaction(): boolean {
        return this.repository.inTransaction;
    }

    invalidateSynced(namespace: string, lease?: CatalogSyncLease): boolean {
        nonempty(namespace, "namespace");
        if (lease !== undefined) this.validateLease(namespace, lease);
        return this.repository.invalidateSynced(namespace, lease);
    }

    acquireSync(namespace: string, ownerToken: string): CatalogSyncLease | undefined {
        nonempty(namespace, "namespace");
        nonempty(ownerToken, "owner token");
        return this.repository.acquireSync(namespace, ownerToken);
    }

    syncLease(namespace: string): CatalogSyncLease | undefined {
        nonempty(namespace, "namespace");
        return this.repository.syncLease(namespace);
    }

    ownsSync(namespace: string, lease: CatalogSyncLease): boolean {
        nonempty(namespace, "namespace");
        this.validateLease(namespace, lease);
        return this.repository.ownsSync(namespace, lease);
    }

    syncStatus(namespace: string): CatalogSyncState & { owned: boolean; revision: number } {
        nonempty(namespace, "namespace");
        return this.repository.syncStatus(namespace);
    }

    releaseSync(namespace: string, lease: CatalogSyncLease): boolean {
        nonempty(namespace, "namespace");
        this.validateLease(namespace, lease);
        return this.repository.releaseSync(namespace, lease);
    }

    /** Explicit offline admin recovery only. First stop the original writer and
     * establish server-side quiescence, then submit the inspected lease. Neither
     * a rejected promise, transport abort nor elapsed time establishes this fact.
     * A successful recovery leaves the namespace dirty and requires a full sync. */
    recoverSync(namespace: string, recovery: CatalogSyncRecovery): boolean {
        nonempty(namespace, "namespace");
        if (recovery?.writerStopped !== true || recovery.remoteWritesQuiesced !== true)
            throw new TypeError("recovery requires stopped writer and quiesced remote writes");
        this.validateLease(namespace, recovery.lease);
        return this.repository.recoverSync(namespace, recovery);
    }

    markSynced(namespace: string, generation: number, lease?: CatalogSyncLease): boolean {
        nonempty(namespace, "namespace");
        if (lease !== undefined) this.validateLease(namespace, lease);
        if (!Number.isSafeInteger(generation) || generation < 0) {
            throw new TypeError("generation must be a non-negative safe integer");
        }
        return this.repository.markSynced(namespace, generation, lease);
    }

    private validateLease(namespace: string, lease: CatalogSyncLease): void {
        if (lease === null || typeof lease !== "object" || lease.namespace !== namespace ||
            !Number.isSafeInteger(lease.revision) || lease.revision < 1)
            throw new TypeError("invalid catalog synchronization lease");
        nonempty(lease.ownerToken, "owner token");
    }

    /** Decode fresh JSON values even when the entry came from the row cache. */
    recordFromEntry(entry: CatalogEntryEntity, relations?: { relation: string; targetId: string }[]): CatalogRecord {
        return {
            id: entry.id, kind: entry.kind, name: entry.name, summary: entry.summary,
            ...(entry.project_id === null ? {} : { projectId: entry.project_id }),
            ...(entry.revision === null ? {} : { revision: entry.revision }),
            ...(entry.source_uri === null ? {} : { sourceUri: entry.source_uri }),
            tags: parseStringArray(entry.tags_json, "tags"),
            searchTerms: parseStringArray(entry.search_terms_json, "searchTerms"),
            payload: parsePayload(entry.payload_json),
            relations: relations === undefined
                ? this.relations(entry.namespace, entry.kind, entry.id)
                : relations.map((relation) => ({ ...relation })),
        };
    }

    private validateIdentity(namespace: string, kind: string, id: string): void {
        nonempty(namespace, "namespace");
        nonempty(kind, "kind");
        nonempty(id, "id");
    }

    override insert(_values: Readonly<Record<string, unknown>>): MutationResult {
        throw new Error("CatalogService writes require replaceSnapshot");
    }

    override update(_id: string, _values: Readonly<Record<string, unknown>>): number {
        throw new Error("CatalogService writes require replaceSnapshot");
    }

    override delete(_id: string): number {
        throw new Error("CatalogService writes require replaceSnapshot");
    }

    override upsert(_values: Readonly<Record<string, unknown>>, _conflictColumns?: readonly string[]): MutationResult {
        throw new Error("CatalogService writes require replaceSnapshot");
    }
}
