import type { SerieDefinition } from "./types.ts";
import { definition as npm } from "./npm.ts";
import { definition as pnpm } from "./pnpm.ts";
import { definition as node } from "./node.ts";
import { definition as maven } from "./maven.ts";
import { definition as gradle } from "./gradle.ts";
import { definition as make } from "./make.ts";
import { definition as android } from "./android.ts";
import { definition as ios } from "./ios.ts";
import { SerieRegistry } from "./registry.ts";

export const serieDefinitions: readonly SerieDefinition[] = Object.freeze([
    npm,
    pnpm,
    node,
    maven,
    gradle,
    make,
    android,
    ios,
]);

/** Create a fresh registry; no mutable process-wide singleton is exposed. */
export function createDefaultSerieRegistry(): SerieRegistry {
    return new SerieRegistry({ definitions: serieDefinitions });
}
