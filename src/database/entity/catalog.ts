import { defineEntity, toTableMeta } from "./entity.ts";
import type { Entity } from "./entity.ts";
import type { TableMeta } from "./meta.ts";

/** A module-independent catalog document; relation targets may be unresolved. */
export interface CatalogRecord {
    id: string;
    kind: string;
    name: string;
    summary: string;
    projectId?: string;
    revision?: string;
    sourceUri?: string;
    tags?: string[];
    searchTerms?: string[];
    payload: Record<string, unknown>;
    relations?: { relation: string; targetId: string }[];
}

export interface CatalogEntryEntity {
    key: string;
    namespace: string;
    id: string;
    kind: string;
    name: string;
    summary: string;
    project_id: string | null;
    revision: string | null;
    source_uri: string | null;
    tags_json: string;
    search_terms_json: string;
    payload_json: string;
    updated_at: string;
}

export interface CatalogRelationEntity {
    key: string;
    namespace: string;
    source_key: string;
    relation: string;
    target_id: string;
}

export interface CatalogSyncStateEntity {
    namespace: string;
    generation: number;
    synced_generation: number;
}

export interface CatalogSyncState {
    generation: number;
    syncedGeneration: number;
}

/** JSON tuples avoid delimiter collisions without restricting module kinds. */
export const catalogKey = (namespace: string, kind: string, id: string): string => JSON.stringify([namespace, kind, id]);

export const CatalogEntryEntityMeta: Entity = defineEntity({
    name: "CatalogEntry",
    table: {
        name: "catalog_entries",
        uniqueConstraints: [{ columnNames: ["namespace", "kind", "id"] }],
        indexes: [{ name: "catalog_entries_namespace", columnList: "namespace, kind, id" }],
    },
    fields: [
        { name: "key", id: true },
        { name: "namespace", column: { nullable: false } },
        { name: "id", column: { nullable: false } },
        { name: "kind", column: { nullable: false } },
        { name: "name", column: { nullable: false } },
        { name: "summary", column: { nullable: false } },
        { name: "project_id" },
        { name: "revision" },
        { name: "source_uri" },
        { name: "tags_json", column: { nullable: false } },
        { name: "search_terms_json", column: { nullable: false } },
        { name: "payload_json", column: { nullable: false } },
        { name: "updated_at", column: { nullable: false } },
    ],
    relations: [{
        name: "relations",
        target: "CatalogRelation",
        mappedBy: "source",
        cascade: { types: ["All"] },
        orphanRemoval: true,
    }],
});

export const CatalogRelationEntityMeta: Entity = defineEntity({
    name: "CatalogRelation",
    table: {
        name: "catalog_relations",
        uniqueConstraints: [{ columnNames: ["source_key", "relation", "target_id"] }],
        indexes: [
            { name: "catalog_relations_source", columnList: "namespace, source_key" },
            { name: "catalog_relations_target", columnList: "namespace, target_id, relation" },
        ],
    },
    fields: [
        { name: "key", id: true },
        { name: "namespace", column: { nullable: false } },
        { name: "source_key", column: { nullable: false } },
        { name: "relation", column: { nullable: false } },
        { name: "target_id", column: { nullable: false } },
    ],
    relations: [{
        name: "source",
        target: "CatalogEntry",
        optional: false,
        joinColumns: [{
            name: "source_key",
            referencedColumnName: "key",
            nullable: false,
            foreignKey: { definition: "REFERENCES catalog_entries(key) ON DELETE CASCADE" },
        }],
    }],
});

export const CatalogSyncStateEntityMeta: Entity = defineEntity({
    name: "CatalogSyncState",
    table: { name: "catalog_sync_state" },
    fields: [
        { name: "namespace", id: true },
        { name: "generation", column: { nullable: false } },
        { name: "synced_generation", column: { nullable: false } },
    ],
});

export const CatalogEntryTable: TableMeta = toTableMeta(CatalogEntryEntityMeta);
export const CatalogRelationTable: TableMeta = toTableMeta(CatalogRelationEntityMeta);
export const CatalogSyncStateTable: TableMeta = toTableMeta(CatalogSyncStateEntityMeta);
