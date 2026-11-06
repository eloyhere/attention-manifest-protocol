import type { SerieDefinition } from "./types.ts";

export const definition: SerieDefinition = Object.freeze({
    id: "npm",
    displayName: "npm",
    kind: "package-manager",
    markers: Object.freeze([
        Object.freeze({ path: "package.json", match: "exact" as const, weight: 2, label: "npm package manifest" }),
        Object.freeze({ path: "package-lock.json", match: "exact" as const, weight: 2, label: "npm lockfile" }),
        Object.freeze({ path: "npm-shrinkwrap.json", match: "exact" as const, weight: 1, label: "npm shrinkwrap lockfile" }),
    ]),
    capabilities: Object.freeze(["install", "build", "test", "run"] as const),
    steps: Object.freeze([
        Object.freeze({ capability: "install" as const, command: "npm install" }),
        Object.freeze({ capability: "build" as const, command: "npm run build" }),
        Object.freeze({ capability: "test" as const, command: "npm test" }),
        Object.freeze({ capability: "run" as const, command: "npm run start" }),
    ]),
    priority: 30,
});
