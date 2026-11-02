/** Descriptive environment metadata; availability is supplied by the host. */
export const EnvironmentCategories = ["runtime", "application", "language", "projectType"] as const;
export type EnvironmentCategory = typeof EnvironmentCategories[number];

export const EnvironmentAvailabilities = ["unknown", "available", "unavailable"] as const;
export type EnvironmentAvailability = typeof EnvironmentAvailabilities[number];

export interface EnvironmentMetadata {
    category: EnvironmentCategory;
    availability: EnvironmentAvailability;
    platforms?: string[];
    extensions?: string[];
    relatedIds?: string[];
    skillIds?: string[];
    knowledgeIds?: string[];
    toolIds?: string[];
    protocolIds?: string[];
}
