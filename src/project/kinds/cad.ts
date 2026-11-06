import type { ProjectKindDefinition } from "./types.ts";

export const definition: ProjectKindDefinition = Object.freeze({
    id: "cad",
    displayName: "CAD",
    language: "cad",
    markers: Object.freeze([
        Object.freeze({ path: ".dwg", match: "suffix" as const, weight: 2, label: "AutoCAD drawing" }),
        Object.freeze({ path: ".dxf", match: "suffix" as const, weight: 2, label: "Drawing exchange format" }),
        Object.freeze({ path: ".dwt", match: "suffix" as const, weight: 1, label: "AutoCAD drawing template" }),
    ]),
    environment: Object.freeze({
        variables: Object.freeze({ ACAD_SUPPORT_PATH: "./support" }),
        paths: Object.freeze(["blocks", "templates", "exports", "support"]),
        dependencies: Object.freeze([
            Object.freeze({ id: "autocad", scope: "tool" as const, optional: true }),
        ]),
    }),
    priority: 30,
});
