import type { ProjectKindDefinition } from "./types.ts";
import { definition as go } from "./go.ts";
import { definition as tex } from "./tex.ts";
import { definition as text } from "./text.ts";
import { definition as photoshop } from "./photoshop.ts";
import { definition as cad } from "./cad.ts";
import { definition as max3d } from "./max3d.ts";
import { definition as solidworks } from "./solidworks.ts";
import { ProjectKindRegistry } from "./registry.ts";

export const projectKindDefinitions: readonly ProjectKindDefinition[] = Object.freeze([
    go,
    tex,
    text,
    photoshop,
    cad,
    max3d,
    solidworks,
]);

/** Create a fresh registry; no mutable process-wide singleton is exposed. */
export function createDefaultProjectKindRegistry(): ProjectKindRegistry {
    return new ProjectKindRegistry({ definitions: projectKindDefinitions });
}
