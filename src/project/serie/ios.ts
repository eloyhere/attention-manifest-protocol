import type { SerieDefinition } from "./types.ts";

export const definition: SerieDefinition = Object.freeze({
    id: "ios",
    displayName: "iOS",
    kind: "platform",
    markers: Object.freeze([
        Object.freeze({ path: "Podfile", match: "exact" as const, weight: 2, label: "CocoaPods manifest" }),
        Object.freeze({ path: "Package.swift", match: "exact" as const, weight: 1, label: "Swift package manifest" }),
        Object.freeze({ path: ".xcodeproj", match: "suffix" as const, weight: 2, label: "Xcode project bundle" }),
        Object.freeze({ path: ".xcworkspace", match: "suffix" as const, weight: 1, label: "Xcode workspace bundle" }),
    ]),
    capabilities: Object.freeze(["build", "test", "package", "bundle"] as const),
    steps: Object.freeze([
        Object.freeze({ capability: "build" as const, command: "xcodebuild -scheme App build" }),
        Object.freeze({ capability: "test" as const, command: "xcodebuild -scheme App test" }),
    ]),
    priority: 60,
});
