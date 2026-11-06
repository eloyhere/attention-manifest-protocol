import type { ProjectKindDefinition } from "./types.ts";

export const definition: ProjectKindDefinition = Object.freeze({
    id: "text",
    displayName: "Plain text",
    language: "text",
    markers: Object.freeze([
        Object.freeze({ path: ".txt", match: "suffix" as const, weight: 2, label: "Plain text document" }),
        Object.freeze({ path: ".text", match: "suffix" as const, weight: 1, label: "Plain text document with a long extension" }),
        Object.freeze({ path: "README", match: "exact" as const, weight: 1, label: "Project readme" }),
        Object.freeze({ path: "LICENSE", match: "exact" as const, weight: 1, label: "Project license" }),
    ]),
    environment: Object.freeze({
        variables: Object.freeze({}),
        paths: Object.freeze(["."]),
        dependencies: Object.freeze([]),
    }),
    priority: 5,
});
