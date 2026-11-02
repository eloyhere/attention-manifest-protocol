import type { WorkspaceEntity, WorkspaceRelation } from "../context/workspace.ts";
import { catalogKey } from "../database/entity/catalog.ts";
import type { CatalogRecord } from "../database/entity/catalog.ts";
import type { HostComponent, HostProject } from "../discover/types.ts";
import type { EnvironmentEntry } from "../environment/catalog.ts";
import type { KnowledgeEntry } from "../knowledge/registry.ts";
import type { ProtocolEntry } from "../protocol/registry.ts";
import { assertJsonValue, jsonArrayShapeProblem } from "../semantic/jsonValue.ts";
import type { SkillEntry } from "../skill/registry.ts";

/** Explicit registered facts only; projection never scans or reads source bodies. */
export interface SearchProjectionInput {
    namespace: string;
    revision?: string;
    workspace?: readonly WorkspaceEntity[];
    relations?: readonly WorkspaceRelation[];
    projects?: readonly HostProject[];
    host?: readonly HostComponent[];
    skills?: readonly SkillEntry[];
    knowledge?: readonly KnowledgeEntry[];
    protocols?: readonly ProtocolEntry[];
    environments?: readonly EnvironmentEntry[];
    records?: readonly CatalogRecord[];
}

type Origin = "workspace" | "projects" | "host" | "skills" | "knowledge" | "protocols" | "environments" | "records";
type Relation = NonNullable<CatalogRecord["relations"]>[number];

const nonempty = (value: unknown, name: string): string => {
    if (typeof value !== "string" || value.trim().length === 0) throw new TypeError(`${name} must be nonempty`);
    return value;
};

/** Drop optional object properties, but reject lossy JSON conversions elsewhere. */
const cleanJson = (value: unknown, seen = new Set<object>()): unknown => {
    if (value === null || typeof value !== "object") {
        assertJsonValue(value, "projection payload");
        return value;
    }
    if (seen.has(value)) throw new TypeError("projection payload contains a cycle");
    const prototype = Object.getPrototypeOf(value);
    if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
        throw new TypeError("projection payload must contain plain JSON objects");
    }
    if (Object.getOwnPropertySymbols(value).length > 0) throw new TypeError("projection payload has symbol keys");
    seen.add(value);
    try {
        if (Array.isArray(value)) {
            const shapeProblem = jsonArrayShapeProblem(value, "projection payload");
            if (shapeProblem !== undefined) throw new TypeError(shapeProblem);
            return Array.from({ length: value.length }, (_, index) => {
                const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
                if (descriptor === undefined || !("value" in descriptor)) throw new TypeError("projection payload has a sparse array or accessor");
                return cleanJson(descriptor.value, seen);
            });
        }
        const result: Record<string, unknown> = {};
        for (const key of Object.keys(value)) {
            const descriptor = Object.getOwnPropertyDescriptor(value, key);
            if (descriptor === undefined || !("value" in descriptor)) throw new TypeError("projection payload has an accessor");
            if (descriptor.value !== undefined) {
                Object.defineProperty(result, key, { value: cleanJson(descriptor.value, seen), enumerable: true, writable: true, configurable: true });
            }
        }
        return result;
    } finally {
        seen.delete(value);
    }
};

const payloadOf = (value: object): Record<string, unknown> => cleanJson(value) as Record<string, unknown>;
const union = (left: readonly string[] = [], right: readonly string[] = []): string[] => [...new Set([...left, ...right])];

/**
 * Build a detached SQLite catalog snapshot with typed relation targets. Only the
 * documented workspace/project and host/environment overlaps are merged.
 */
export const projectSearchRecords = (input: SearchProjectionInput): CatalogRecord[] => {
    const safe = payloadOf(input) as unknown as SearchProjectionInput;
    const namespace = nonempty(safe.namespace, "namespace");
    if (safe.revision !== undefined) nonempty(safe.revision, "revision");
    input = safe;
    const result = new Map<string, CatalogRecord>();
    const origins = new Map<string, Set<Origin>>();
    const keyOf = (kind: string, id: string): string => catalogKey(namespace, kind, id);
    const addRelation = (record: CatalogRecord, relation: string, targetId: string): void => {
        const edges = record.relations ??= [];
        if (!edges.some((edge) => edge.relation === relation && edge.targetId === targetId)) edges.push({ relation, targetId });
    };
    const put = (candidate: CatalogRecord, origin: Origin): CatalogRecord => {
        const record = payloadOf(candidate) as unknown as CatalogRecord;
        nonempty(record.id, "record.id");
        nonempty(record.kind, "record.kind");
        nonempty(record.name, "record.name");
        if (typeof record.summary !== "string") throw new TypeError("record.summary must be a string");
        for (const field of ["projectId", "revision", "sourceUri"] as const) {
            if (record[field] !== undefined) nonempty(record[field], `record.${field}`);
        }
        for (const field of ["tags", "searchTerms"] as const) {
            if (record[field] !== undefined && (!Array.isArray(record[field]) || record[field]!.some((value) => typeof value !== "string" || value.trim().length === 0))) {
                throw new TypeError(`record.${field} must contain only nonempty strings`);
            }
        }
        const key = keyOf(record.kind, record.id);
        const existing = result.get(key);
        if (existing === undefined) {
            result.set(key, record);
            origins.set(key, new Set([origin]));
            return record;
        }
        const previous = origins.get(key)!;
        const mergeProject = origin === "projects" && record.kind === "project" && previous.size === 1 && previous.has("workspace");
        const mergeEnvironment = origin === "environments" && previous.size === 1 && previous.has("host");
        if (!mergeProject && !mergeEnvironment) throw new TypeError(`duplicate projected search record: ${record.kind}/${record.id}`);
        if (existing.projectId !== undefined && record.projectId !== undefined && existing.projectId !== record.projectId) {
            throw new TypeError(`conflicting project for projected search record: ${record.kind}/${record.id}`);
        }
        const payload = { ...existing.payload, ...record.payload,
            ...(mergeProject ? { workspace: existing.payload, project: record.payload } : { host: existing.payload, environment: record.payload }) };
        const relations = [...(existing.relations ?? [])];
        const merged: CatalogRecord = { ...existing, ...record, payload,
            tags: union(existing.tags, record.tags), searchTerms: union(existing.searchTerms, record.searchTerms), relations };
        for (const edge of record.relations ?? []) addRelation(merged, edge.relation, edge.targetId);
        result.set(key, merged);
        previous.add(origin);
        return merged;
    };
    const workspaceById = new Map<string, WorkspaceEntity>();
    for (const source of input.workspace ?? []) {
        const item = payloadOf(source) as unknown as WorkspaceEntity;
        if (workspaceById.has(item.id)) throw new TypeError(`duplicate workspace id: ${item.id}`);
        workspaceById.set(item.id, item);
        put({ id: item.id, kind: item.kind, name: item.label, summary: item.summary, projectId: item.projectId,
            revision: input.revision ?? item.source.revision, sourceUri: item.source.uri,
            tags: item.tags ?? [], searchTerms: item.searchTerms ?? [], payload: payloadOf(item) }, "workspace");
    }
    const workspaceTarget = (id: string): string => {
        const entity = workspaceById.get(id);
        return entity === undefined ? id : keyOf(entity.kind, id);
    };
    for (const item of input.projects ?? []) {
        put({ id: item.id, kind: "project", name: item.name, summary: item.summary, projectId: item.id,
            ...(input.revision === undefined ? {} : { revision: input.revision }), tags: item.tags ?? [],
            searchTerms: [item.description, item.purpose].filter((value) => value.trim().length > 0), payload: payloadOf(item),
            ...(item.rootId === undefined || item.rootId === item.id ? {} : { relations: [{ relation: "workspace", targetId: workspaceTarget(item.rootId) }] }) }, "projects");
    }
    const component = (source: HostComponent, origin: "host" | "environments"): void => {
        const item = payloadOf(source) as unknown as HostComponent;
        const relations: Relation[] = [
            ...(item.relatedIds ?? []).map((id) => ({ relation: "related", targetId: id })),
            ...([["skillIds", "skill", "uses_skill"], ["knowledgeIds", "knowledge", "uses_knowledge"],
                ["toolIds", "tool", "uses_tool"], ["protocolIds", "protocol", "uses_protocol"]] as const)
                .flatMap(([field, kind, relation]) => (item[field] ?? []).map((id) => ({ relation, targetId: keyOf(kind, id) }))),
        ];
        if (item.projectId !== undefined) relations.push({ relation: "project", targetId: keyOf("project", item.projectId) });
        put({ id: item.id, kind: item.kind, name: item.name, summary: item.description,
            ...(item.projectId === undefined ? {} : { projectId: item.projectId }),
            ...(item.projectId === undefined || input.revision === undefined ? {} : { revision: input.revision }),
            tags: union(item.capabilities, [...(item.platforms ?? []), ...(item.extensions ?? [])]),
            searchTerms: [item.version, item.category, item.availability, item.purpose].filter((value): value is string => value !== undefined && value.trim().length > 0),
            payload: payloadOf(item), relations }, origin);
    };
    for (const item of input.host ?? []) component(item, "host");
    for (const item of input.environments ?? []) component(item, "environments");
    for (const item of input.skills ?? []) {
        if (item.enabled === false) continue;
        put({ id: item.id, kind: "skill", name: item.name, summary: item.description, tags: item.tags ?? [],
            searchTerms: [...(item.version === undefined ? [] : [item.version]), ...(item.capabilities ?? [])], payload: payloadOf(item) }, "skills");
    }
    for (const item of input.knowledge ?? []) {
        put({ id: item.id, kind: "knowledge", name: item.title, summary: item.summary,
            ...(item.sourceUri === undefined ? {} : { sourceUri: item.sourceUri }), tags: item.tags ?? [],
            searchTerms: item.version === undefined ? [] : [item.version], payload: payloadOf(item),
            relations: (item.skillIds ?? []).map((id) => ({ relation: "uses_skill", targetId: keyOf("skill", id) })) }, "knowledge");
    }
    for (const item of input.protocols ?? []) {
        if (item.status === "disabled") continue;
        put({ id: item.id, kind: "protocol", name: item.name, summary: item.description,
            searchTerms: [item.version, ...(item.capabilities ?? [])], payload: payloadOf(item) }, "protocols");
    }
    for (const item of input.records ?? []) {
        if ((item.kind === "skill" && item.payload.enabled === false) || (item.kind === "protocol" && item.payload.status === "disabled")) continue;
        put(item, "records");
    }
    for (const item of input.workspace ?? []) {
        const record = result.get(keyOf(item.kind, item.id))!;
        if (item.parentId !== undefined) {
            const parentKey = workspaceTarget(item.parentId);
            addRelation(record, "parent", parentKey);
            const parent = result.get(parentKey);
            if (parent !== undefined) addRelation(parent, "contains", keyOf(item.kind, item.id));
        }
        if (item.kind !== "project" || item.id !== item.projectId) {
            const projectKey = keyOf("project", item.projectId);
            addRelation(record, "project", projectKey);
            const project = result.get(projectKey);
            if (project !== undefined && item.parentId === undefined) addRelation(project, "contains", keyOf(item.kind, item.id));
        }
    }
    for (const edge of input.relations ?? []) {
        const from = workspaceTarget(edge.from);
        const source = result.get(from);
        if (source === undefined) throw new TypeError(`workspace relation source is missing: ${edge.from}`);
        addRelation(source, nonempty(edge.kind, "relation.kind"), workspaceTarget(edge.to));
        const edges = source.payload.workspaceRelations;
        const preserved = Array.isArray(edges) ? edges : [];
        preserved.push(payloadOf(edge));
        source.payload.workspaceRelations = preserved;
    }
    // Validate and deduplicate relation lists from both projections and generic modules.
    for (const record of result.values()) {
        const edges = record.relations ?? [];
        record.relations = [];
        for (const edge of edges) addRelation(record, nonempty(edge.relation, "relation"), nonempty(edge.targetId, "targetId"));
        assertJsonValue(record, "projected record");
    }
    return [...result.values()];
};
