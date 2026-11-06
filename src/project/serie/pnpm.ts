import type { SerieDefinition } from "./types.ts";

export const definition: SerieDefinition = Object.freeze({
    id: "pnpm",
    displayName: "pnpm",
    kind: "package-manager",
    markers: Object.freeze([
        Object.freeze({ path: "pnpm-lock.yaml", match: "exact" as const, weight: 2, label: "pnpm lockfile" }),
        Object.freeze({ path: "pnpm-workspace.yaml", match: "exact" as const, weight: 2, label: "pnpm workspace manifest" }),
        Object.freeze({ path: "package.json", match: "exact" as const, weight: 1, label: "package manifest" }),
    ]),
    capabilities: Object.freeze(["install", "build", "test", "run"] as const),
    steps: Object.freeze([
        Object.freeze({ capability: "install" as const, command: "pnpm install" }),
        Object.freeze({ capability: "build" as const, command: "pnpm run build" }),
        Object.freeze({ capability: "test" as const, command: "pnpm test" }),
        Object.freeze({ capability: "run" as const, command: "pnpm run start" }),
    ]),
    priority: 35,
});
