import { InMemoryRegistry } from "../registry/memory.ts";

/** Registry for source-aware, discoverable knowledge entries. */
export interface KnowledgeEntry {
    id: string;
    title: string;
    summary: string;
    content: string;
    sourceUri?: string;
    version?: string;
    tags?: string[];
    skillIds?: string[];
    updatedAt?: string;
}

const cloneKnowledge: (knowledge: KnowledgeEntry) => KnowledgeEntry = (knowledge: KnowledgeEntry): KnowledgeEntry => ({
    ...knowledge,
    ...(knowledge.tags === (void 0) ? {} : { tags: [...knowledge.tags] }),
    ...(knowledge.skillIds === (void 0) ? {} : { skillIds: [...knowledge.skillIds] }),
});

const validateKnowledge: (knowledge: KnowledgeEntry) => void = (knowledge: KnowledgeEntry): void => {
    for (const [field, value] of Object.entries({ id: knowledge.id, title: knowledge.title, summary: knowledge.summary, content: knowledge.content })) {
        if (typeof(value) !== "string" || value.trim().length === 0) {
            throw new Error(`knowledge ${field} must be a non-empty string`);
        }
    }
    for (const [field, values] of Object.entries({ tags: knowledge.tags, skillIds: knowledge.skillIds })) {
        if (values !== (void 0) && (!Array.isArray(values) || values.some((value: string): boolean => typeof(value) !== "string" || value.trim().length === 0))) {
            throw new Error(`knowledge ${field} must contain non-empty strings`);
        }
    }
    if (knowledge.sourceUri !== (void 0) && knowledge.sourceUri.trim().length === 0) {
        throw new Error("knowledge sourceUri must be a non-empty string");
    }
};

export class KnowledgeRegistry {
    private readonly entries: InMemoryRegistry<KnowledgeEntry> = new InMemoryRegistry<KnowledgeEntry>(cloneKnowledge, (id: string): Error => new Error(`knowledge ${id} is already registered`));

    register(knowledge: KnowledgeEntry): KnowledgeEntry {
        validateKnowledge(knowledge);
        return this.entries.register(knowledge);
    }

    get(id: string): KnowledgeEntry | undefined {
        return this.entries.get(id);
    }

    list(): KnowledgeEntry[] {
        return this.entries.list({
            compare: (left: KnowledgeEntry, right: KnowledgeEntry): number => left.title.localeCompare(right.title) || left.id.localeCompare(right.id),
        });
    }

    has(id: string): boolean {
        return this.entries.has(id);
    }
}
