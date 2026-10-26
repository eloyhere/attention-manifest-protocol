import { defineEntity, toTableMeta } from "./entity.ts";
import type { Entity } from "./entity.ts";
import type { TableMeta } from "./meta.ts";

/**
 * Current state of one concept; history lives in `objects`.
 */
export interface ConceptEntity {
    cid: number;
    id: string;
    label: string;
    definition: string;
    status: string;
    version: number;
    object_seq: number | null;
    digest: string | null;
    created_at: string;
    updated_at: string;
}

/**
 * JPA metadata for the concept registry.
 */
export const ConceptEntityMeta: Entity = defineEntity({
    name: "Concept",
    table: {
        name: "concepts",
        uniqueConstraints: [{ columnNames: ["id"] }],
    },
    fields: [
        { name: "cid", id: true, generated: { strategy: "Identity" } },
        { name: "id" },
        { name: "label" },
        { name: "definition" },
        { name: "status" },
        { name: "version", version: true },
        { name: "object_seq" },
        { name: "digest" },
        { name: "created_at" },
        { name: "updated_at" },
    ],
});

/**
 * Table view used by the repository and SQL layers.
 */
export const ConceptTable: TableMeta = toTableMeta(ConceptEntityMeta);

/**
 * Current state of one module (a code directory is only its physical shadow).
 */
export interface ModuleEntity {
    mid: number;
    id: string;
    kind: string;
    entry: string;
    description: string;
    status: string;
    version: number;
    object_seq: number | null;
    digest: string | null;
    content_digest: string | null;
    created_at: string;
    updated_at: string;
}

/**
 * JPA metadata for the module registry.
 */
export const ModuleEntityMeta: Entity = defineEntity({
    name: "Module",
    table: {
        name: "modules",
        uniqueConstraints: [{ columnNames: ["id"] }],
    },
    fields: [
        { name: "mid", id: true, generated: { strategy: "Identity" } },
        { name: "id" },
        { name: "kind" },
        { name: "entry" },
        { name: "description" },
        { name: "status" },
        { name: "version", version: true },
        { name: "object_seq" },
        { name: "digest" },
        { name: "content_digest" },
        { name: "created_at" },
        { name: "updated_at" },
    ],
});

/**
 * Table view used by the repository and SQL layers.
 */
export const ModuleTable: TableMeta = toTableMeta(ModuleEntityMeta);

/**
 * Link between a module and a concept.
 */
export interface ModuleConceptEntity {
    mid: number;
    cid: number;
    role: string;
}

/**
 * JPA metadata for the module-concept join table.
 */
export const ModuleConceptEntityMeta: Entity = defineEntity({
    name: "ModuleConcept",
    table: {
        name: "module_concepts",
    },
    idClass: "ModuleConceptId",
    fields: [
        { name: "mid", id: true },
        { name: "cid", id: true },
        { name: "role", id: true },
    ],
});

/**
 * Current state of one attestation.
 */
export interface AttestationEntity {
    aid: number;
    subject_kind: string;
    subject_id: string;
    claim_id: string;
    object_seq: number | null;
    at: string;
}

/**
 * JPA metadata for registry attestations.
 */
export const AttestationEntityMeta: Entity = defineEntity({
    name: "Attestation",
    table: {
        name: "attestations",
    },
    fields: [
        { name: "aid", id: true, generated: { strategy: "Identity" } },
        { name: "subject_kind" },
        { name: "subject_id" },
        { name: "claim_id" },
        { name: "object_seq" },
        { name: "at" },
    ],
});

/**
 * Table view used by the repository and SQL layers.
 */
export const AttestationTable: TableMeta = toTableMeta(AttestationEntityMeta);
