import type { ProjectKindDefinition } from "./types.ts";

export const definition: ProjectKindDefinition = Object.freeze({
    id: "go",
    displayName: "Go",
    language: "go",
    markers: Object.freeze([
        Object.freeze({ path: "go.mod", match: "exact" as const, weight: 2, label: "Go module manifest" }),
        Object.freeze({ path: "go.sum", match: "exact" as const, weight: 2, label: "Go module checksum database" }),
        Object.freeze({ path: "go.work", match: "exact" as const, weight: 1, label: "Go workspace file" }),
        Object.freeze({ path: ".go", match: "suffix" as const, weight: 1, label: "Go source file" }),
    ]),
    environment: Object.freeze({
        variables: Object.freeze({ GO111MODULE: "on", GOFLAGS: "-mod=readonly" }),
        paths: Object.freeze(["cmd", "internal", "pkg", "bin"]),
        dependencies: Object.freeze([
            Object.freeze({ id: "go", scope: "build" as const, manager: "go" }),
        ]),
    }),
    priority: 50,
});
