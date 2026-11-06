import type { SerieDefinition } from "./types.ts";

export const definition: SerieDefinition = Object.freeze({
    id: "node",
    displayName: "Node.js",
    kind: "runtime",
    markers: Object.freeze([
        Object.freeze({ path: ".nvmrc", match: "exact" as const, weight: 2, label: "nvm runtime version" }),
        Object.freeze({ path: ".node-version", match: "exact" as const, weight: 2, label: "Node.js runtime version" }),
        Object.freeze({ path: "package.json", match: "exact" as const, weight: 1, label: "package manifest" }),
    ]),
    capabilities: Object.freeze(["run", "test"] as const),
    steps: Object.freeze([
        Object.freeze({ capability: "run" as const, command: "node --version" }),
        Object.freeze({ capability: "test" as const, command: "npm test" }),
    ]),
    priority: 10,
});
