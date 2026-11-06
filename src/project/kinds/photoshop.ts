import type { ProjectKindDefinition } from "./types.ts";

export const definition: ProjectKindDefinition = Object.freeze({
    id: "photoshop",
    displayName: "Adobe Photoshop",
    language: "photoshop",
    markers: Object.freeze([
        Object.freeze({ path: ".psd", match: "suffix" as const, weight: 2, label: "Photoshop document" }),
        Object.freeze({ path: ".psb", match: "suffix" as const, weight: 1, label: "Photoshop large document" }),
        Object.freeze({ path: ".psdt", match: "suffix" as const, weight: 1, label: "Photoshop template" }),
    ]),
    environment: Object.freeze({
        variables: Object.freeze({ PHOTOSHOP_SCRIPTS: "./scripts" }),
        paths: Object.freeze(["assets", "exports", "scripts"]),
        dependencies: Object.freeze([
            Object.freeze({ id: "photoshop", scope: "tool" as const }),
        ]),
    }),
    priority: 30,
});
