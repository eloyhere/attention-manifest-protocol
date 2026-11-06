import type { SerieDefinition } from "./types.ts";

export const definition: SerieDefinition = Object.freeze({
    id: "make",
    displayName: "Make",
    kind: "build-system",
    markers: Object.freeze([
        Object.freeze({ path: "GNUmakefile", match: "exact" as const, weight: 2, label: "GNU makefile" }),
        Object.freeze({ path: "Makefile", match: "exact" as const, weight: 2, label: "makefile" }),
        Object.freeze({ path: "makefile", match: "exact" as const, weight: 1, label: "lowercase makefile" }),
    ]),
    capabilities: Object.freeze(["build", "test"] as const),
    steps: Object.freeze([
        Object.freeze({ capability: "build" as const, command: "make" }),
        Object.freeze({ capability: "test" as const, command: "make test" }),
    ]),
    priority: 20,
});
