import type { SerieDefinition } from "./types.ts";

export const definition: SerieDefinition = Object.freeze({
    id: "maven",
    displayName: "Maven",
    kind: "build-system",
    markers: Object.freeze([
        Object.freeze({ path: "pom.xml", match: "exact" as const, weight: 2, label: "Maven project descriptor" }),
    ]),
    capabilities: Object.freeze(["build", "test"] as const),
    steps: Object.freeze([
        Object.freeze({ capability: "build" as const, command: "mvn -B verify" }),
        Object.freeze({ capability: "test" as const, command: "mvn -B test" }),
    ]),
    priority: 40,
});
