import type { ProjectKindDefinition } from "./types.ts";

export const definition: ProjectKindDefinition = Object.freeze({
    id: "solidworks",
    displayName: "SolidWorks",
    language: "solidworks",
    markers: Object.freeze([
        Object.freeze({ path: ".sldprt", match: "suffix" as const, weight: 2, label: "SolidWorks part" }),
        Object.freeze({ path: ".sldasm", match: "suffix" as const, weight: 2, label: "SolidWorks assembly" }),
        Object.freeze({ path: ".slddrw", match: "suffix" as const, weight: 1, label: "SolidWorks drawing" }),
        Object.freeze({ path: ".sldtpl", match: "suffix" as const, weight: 1, label: "SolidWorks template" }),
    ]),
    environment: Object.freeze({
        variables: Object.freeze({ SW_TEMPLATES: "./templates" }),
        paths: Object.freeze(["parts", "assemblies", "drawings", "templates"]),
        dependencies: Object.freeze([
            Object.freeze({ id: "solidworks", scope: "tool" as const }),
        ]),
    }),
    priority: 30,
});
