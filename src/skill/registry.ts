import { InMemoryRegistry } from "../registry/memory.ts";

/** Registry for reusable agent skills. */
export interface SkillEntry {
    id: string;
    name: string;
    description: string;
    instructions: string;
    version?: string;
    tags?: string[];
    capabilities?: string[];
    enabled?: boolean;
}

const cloneSkill: (skill: SkillEntry) => SkillEntry = (skill: SkillEntry): SkillEntry => ({
    ...skill,
    ...(skill.tags === (void 0) ? {} : { tags: [...skill.tags] }),
    ...(skill.capabilities === (void 0) ? {} : { capabilities: [...skill.capabilities] }),
});

const validateSkill: (skill: SkillEntry) => void = (skill: SkillEntry): void => {
    for (const [field, value] of Object.entries({ id: skill.id, name: skill.name, description: skill.description, instructions: skill.instructions })) {
        if (typeof(value) !== "string" || value.trim().length === 0) {
            throw new Error(`skill ${field} must be a non-empty string`);
        }
    }
    for (const [field, values] of Object.entries({ tags: skill.tags, capabilities: skill.capabilities })) {
        if (values !== (void 0) && (!Array.isArray(values) || values.some((value: string): boolean => typeof(value) !== "string" || value.trim().length === 0))) {
            throw new Error(`skill ${field} must contain non-empty strings`);
        }
    }
};

export class SkillRegistry {
    private readonly entries: InMemoryRegistry<SkillEntry> = new InMemoryRegistry<SkillEntry>(cloneSkill, (id: string): Error => new Error(`skill ${id} is already registered`));

    register(skill: SkillEntry): SkillEntry {
        validateSkill(skill);
        return this.entries.register(skill);
    }

    get(id: string): SkillEntry | undefined {
        return this.entries.get(id);
    }

    list(options: { enabledOnly?: boolean } = {}): SkillEntry[] {
        return this.entries.list({
            filter: (skill: SkillEntry): boolean => options.enabledOnly !== true || skill.enabled !== false,
            compare: (left: SkillEntry, right: SkillEntry): number => left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
        });
    }

    has(id: string): boolean {
        return this.entries.has(id);
    }
}
