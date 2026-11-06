import type { ProjectKindDefinition } from "./types.ts";

export const definition: ProjectKindDefinition = Object.freeze({
    id: "max3d",
    displayName: "Autodesk 3ds Max",
    language: "max3d",
    markers: Object.freeze([
        Object.freeze({ path: ".max", match: "suffix" as const, weight: 2, label: "3ds Max scene" }),
        Object.freeze({ path: ".3ds", match: "suffix" as const, weight: 1, label: "3ds Max legacy scene" }),
        Object.freeze({ path: ".mat", match: "suffix" as const, weight: 1, label: "3ds Max material library" }),
    ]),
    environment: Object.freeze({
        variables: Object.freeze({ ADSK_3DSMAX_VERSION: "2025" }),
        paths: Object.freeze(["scenes", "materials", "renders", "scripts"]),
        dependencies: Object.freeze([
            Object.freeze({ id: "3dsmax", scope: "tool" as const }),
        ]),
    }),
    priority: 30,
});
