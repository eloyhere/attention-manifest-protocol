import type { SerieDefinition } from "./types.ts";

export const definition: SerieDefinition = Object.freeze({
    id: "android",
    displayName: "Android",
    kind: "platform",
    markers: Object.freeze([
        Object.freeze({ path: "AndroidManifest.xml", match: "exact" as const, weight: 2, label: "Android application manifest" }),
        Object.freeze({ path: "build.gradle", match: "exact" as const, weight: 1, label: "Gradle build script" }),
        Object.freeze({ path: "settings.gradle", match: "exact" as const, weight: 1, label: "Gradle settings script" }),
        Object.freeze({ path: "gradle.properties", match: "exact" as const, weight: 1, label: "Gradle properties" }),
    ]),
    capabilities: Object.freeze(["build", "test", "package"] as const),
    steps: Object.freeze([
        Object.freeze({ capability: "build" as const, command: "./gradlew assembleDebug" }),
        Object.freeze({ capability: "test" as const, command: "./gradlew test" }),
    ]),
    priority: 60,
});
