import type { SerieDefinition } from "./types.ts";

export const definition: SerieDefinition = Object.freeze({
    id: "gradle",
    displayName: "Gradle",
    kind: "build-system",
    markers: Object.freeze([
        Object.freeze({ path: "build.gradle", match: "exact" as const, weight: 2, label: "Gradle build script" }),
        Object.freeze({ path: "build.gradle.kts", match: "exact" as const, weight: 2, label: "Gradle Kotlin build script" }),
        Object.freeze({ path: "settings.gradle", match: "exact" as const, weight: 1, label: "Gradle settings script" }),
        Object.freeze({ path: "settings.gradle.kts", match: "exact" as const, weight: 1, label: "Gradle Kotlin settings script" }),
        Object.freeze({ path: "gradlew", match: "exact" as const, weight: 2, label: "Gradle wrapper" }),
    ]),
    capabilities: Object.freeze(["build", "test"] as const),
    steps: Object.freeze([
        Object.freeze({ capability: "build" as const, command: "./gradlew build" }),
        Object.freeze({ capability: "test" as const, command: "./gradlew test" }),
    ]),
    priority: 40,
});
