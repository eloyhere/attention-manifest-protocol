import type { CatalogRecord } from "../database/entity/catalog.ts";
import { catalogKey } from "../database/entity/catalog.ts";
import type { ScopedControlService } from "./service.ts";

const Kinds = { modules: "module", skills: "skill", knowledge: "knowledge", protocols: "protocol", environments: "environment", concepts: "concept" } as const;
const optionalStrings = (value: unknown): string[] => Array.isArray(value) && value.every(item => typeof item === "string" && item.trim()) ? [...value] : [];
/** Rebuild a workspace's metadata snapshot from authoritative registry overlays.
 * The host chooses namespace/workspace/project. Registry data cannot assign scope.
 * Existing executable tool descriptors are never created or changed by this adapter.
 */
export const applyControlRegistry = (control: ScopedControlService, workspaceId: string, namespace: string,
    base: readonly CatalogRecord[], revision?: string, projectId?: string): CatalogRecord[] => {
    const records = new Map(base.map(record => [catalogKey(namespace, record.kind, record.id), structuredClone(record)]));
    for (const [registry, kind] of Object.entries(Kinds)) {
        for (const entry of control.listRegistry(workspaceId, registry, true)) {
            const id = entry.id as string;
            const key = catalogKey(namespace, kind, id);
            if (entry.status === "removed") { records.delete(key); continue; }
            const value = entry.value as Record<string, unknown>;
            if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("registry metadata must be an object");
            if (value.status === "disabled") { records.delete(key); continue; }
            const name = typeof value.name === "string" && value.name.trim() ? value.name : typeof value.label === "string" && value.label.trim() ? value.label : id;
            const summary = typeof value.summary === "string" ? value.summary : typeof value.description === "string" ? value.description : "";
            const previous = records.get(key);
            const links = entry.links as Array<{ relation: string; targetId: string }>;
            records.set(key, { id, kind, name, summary,
                ...(projectId === undefined ? previous?.projectId === undefined ? {} : { projectId: previous.projectId } : { projectId }),
                ...(revision === undefined ? {} : { revision }),
                tags: optionalStrings(value.tags), searchTerms: optionalStrings(value.searchTerms),
                payload: { ...value, registry, registryVersion: entry.version },
                relations: links.map(link => ({ relation: link.relation, targetId: catalogKey(namespace, kind, link.targetId) })),
            });
        }
    }
    return [...records.values()];
};
