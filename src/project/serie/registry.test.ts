import assert from "node:assert/strict";
import test from "node:test";
import { Optional } from "semantic-typescript";
import { serie } from "../index.ts";
import { createDefaultSerieRegistry, serieDefinitions } from "./builtins.ts";
import { SerieRegistry } from "./registry.ts";
import type { SerieCapability, SerieDefinition, SerieDetection, SerieKind, SerieMarker } from "./types.ts";

const marker = (path: string, match: SerieMarker["match"] = "exact", weight = 1): SerieMarker => ({
    path,
    match,
    weight,
    label: `${match}:${path}`,
});

const definition = (id: string, overrides: Partial<SerieDefinition> = {}): SerieDefinition => ({
    id,
    displayName: id.toUpperCase(),
    kind: "build-system",
    markers: [marker(`${id}.marker`)],
    capabilities: ["build"],
    steps: [{ capability: "build", command: `build ${id}` }],
    priority: 50,
    ...overrides,
});

const top = (registry: SerieRegistry, files: readonly string[]): SerieDetection => {
    const detection = registry.detect(files)[0];
    if (detection === undefined) throw new Error(`expected a detection for ${files.join(", ")}`);
    return detection;
};

test("normalizes definitions and freezes their nested structures", () => {
    const registry = new SerieRegistry();
    const registered = registry.register({
        ...definition("npm"),
        id: " NPM ",
        displayName: " npm ",
        capabilities: ["build", "build", "test"],
        steps: [{ capability: "build", command: " npm run build " }],
        notes: " note ",
    });
    assert.equal(registered.id, "npm");
    assert.equal(registered.displayName, "npm");
    assert.deepEqual(registered.capabilities, ["build", "test"]);
    assert.equal(registered.steps[0]?.command, "npm run build");
    assert.equal(registered.notes, "note");
    assert.equal(Object.isFrozen(registered), true);
    assert.equal(Object.isFrozen(registered.markers), true);
    assert.equal(Object.isFrozen(registered.markers[0]), true);
    assert.equal(Object.isFrozen(registered.capabilities), true);
    assert.equal(Object.isFrozen(registered.steps), true);
    assert.equal(Object.isFrozen(registered.steps[0]), true);
    assert.equal(registry.find("NPM").get().id, "npm");
});

test("rejects invalid identifiers, evidence and steps", () => {
    const registry = new SerieRegistry();
    const invalid: readonly SerieDefinition[] = [
        definition("bad id"),
        definition("bad/id"),
        definition("good", { displayName: " " }),
        definition("good", { kind: "toolchain" as SerieKind }),
        definition("good", { markers: [] }),
        definition("good", { markers: [{ ...marker("m"), label: " " }] }),
        definition("good", { markers: [marker("m", "glob" as SerieMarker["match"])] }),
        definition("good", { markers: [marker("m", "exact", 0)] }),
        definition("good", { markers: [marker("m", "exact", 4)] }),
        definition("good", { markers: [marker("m", "exact", 1.5)] }),
        definition("good", { markers: [marker("/abs")] }),
        definition("good", { markers: [marker("../x")] }),
        definition("good", { markers: [marker("a\\b")] }),
        definition("good", { markers: [marker("m"), marker("m")] }),
        definition("good", { capabilities: [] }),
        definition("good", { capabilities: ["deploy" as SerieCapability] }),
        definition("good", { capabilities: ["build"], steps: [{ capability: "test", command: "test" }] }),
        definition("good", { steps: [{ capability: "build", command: " " }] }),
        definition("good", { priority: -1 }),
        definition("good", { priority: 101 }),
        definition("good", { priority: 1.5 }),
        definition("good", { notes: 42 as unknown as string }),
    ];
    for (const candidate of invalid) assert.throws(() => registry.register(candidate), TypeError);
    assert.equal(registry.list().length, 0);
    assert.equal(registry.version, 0);
});

test("registerMany is atomic and preserves registration order", () => {
    const registry = new SerieRegistry();
    registry.register(definition("a"));
    const epoch = registry.version;
    assert.throws(() => registry.registerMany([definition("b"), definition("c", { markers: [] })]), TypeError);
    assert.deepEqual(registry.list().map(item => item.id), ["a"]);
    assert.equal(registry.version, epoch);
    assert.throws(() => registry.registerMany([definition("b"), definition("b")]), /already registered/);
    assert.deepEqual(registry.list().map(item => item.id), ["a"]);
    assert.throws(() => registry.registerMany([definition("a")]), /already registered/);
    const registered = registry.registerMany([definition("b"), definition("c")]);
    assert.deepEqual(registered.map(item => item.id), ["b", "c"]);
    assert.deepEqual(registry.list().map(item => item.id), ["a", "b", "c"]);
    assert.equal(registry.version, epoch + 1);
    assert.equal(new SerieRegistry({ definitions: [definition("x"), definition("y")] }).version, 1);
});

test("find returns Optional and list is an isolated snapshot", () => {
    const registry = new SerieRegistry({ definitions: [definition("a"), definition("b")] });
    assert.ok(registry.find("a") instanceof Optional);
    assert.equal(registry.find("A").get().id, "a");
    assert.equal(registry.find("missing").isEmpty(), true);
    assert.equal(registry.find(42 as unknown as string).isEmpty(), true);
    const list = registry.list();
    assert.equal(Object.isFrozen(list), true);
    assert.equal(Object.isFrozen(list[0]?.markers), true);
    assert.throws(() => (list as SerieDefinition[]).pop(), TypeError);
    assert.deepEqual(registry.list().map(item => item.id), ["a", "b"]);
    assert.throws(() => registry.requireDefinition("missing"), /unknown serie/);
    assert.equal(registry.requireDefinition("a").id, "a");
    assert.equal(Object.isFrozen(registry.snapshot()), true);
    assert.equal(Object.isFrozen(registry.snapshot().definitions), true);
});

test("unregister retires an id permanently and advances the epoch", () => {
    const registry = new SerieRegistry();
    assert.equal(registry.version, 0);
    assert.equal(registry.epoch, 0);
    registry.register(definition("a"));
    assert.equal(registry.version, 1);
    registry.registerMany([definition("b"), definition("c")]);
    assert.equal(registry.version, 2);
    const snapshot = registry.snapshot();
    assert.equal(snapshot.epoch, 2);
    assert.equal(registry.unregister("a"), true);
    assert.equal(registry.version, 3);
    assert.equal(registry.epoch, 3);
    assert.equal(registry.unregister("a"), false);
    assert.equal(registry.unregister("missing"), false);
    assert.equal(registry.version, 3);
    assert.throws(() => registry.register(definition("a")), /retired/);
    assert.throws(() => registry.register(definition("A")), /retired/);
    assert.deepEqual(registry.list().map(item => item.id), ["b", "c"]);
    assert.equal(snapshot.definitions.length, 3);
    assert.equal(registry.snapshot().definitions.length, 2);
});

test("detects package managers and the Node runtime", () => {
    const registry = createDefaultSerieRegistry();
    assert.equal(top(registry, ["package.json", "package-lock.json"]).serie.id, "npm");
    assert.equal(top(registry, ["package-lock.json"]).score, 2);
    const pnpm = top(registry, ["package.json", "pnpm-lock.yaml"]);
    assert.equal(pnpm.serie.id, "pnpm");
    assert.equal(pnpm.score, 3);
    assert.deepEqual(pnpm.matched.map(item => item.path), ["pnpm-lock.yaml", "package.json"]);
    assert.deepEqual(pnpm.evidence, ["pnpm-lock.yaml", "package.json"]);
    assert.equal(top(registry, ["package.json"]).serie.id, "npm");
    assert.equal(top(registry, ["pnpm-workspace.yaml"]).serie.id, "pnpm");
    assert.equal(top(registry, ["npm-shrinkwrap.json", "package.json"]).serie.id, "npm");
    assert.equal(top(registry, [".nvmrc", "package.json"]).serie.id, "node");
    assert.equal(top(registry, [".node-version"]).serie.id, "node");
});

test("detects Maven, Gradle and Make evidence", () => {
    const registry = createDefaultSerieRegistry();
    assert.equal(top(registry, ["pom.xml"]).serie.id, "maven");
    assert.equal(top(registry, ["build.gradle", "gradlew"]).serie.id, "gradle");
    assert.equal(top(registry, ["build.gradle.kts", "settings.gradle.kts"]).serie.id, "gradle");
    assert.equal(top(registry, ["Makefile"]).serie.id, "make");
    assert.equal(top(registry, ["GNUmakefile"]).serie.id, "make");
    assert.equal(top(registry, ["makefile"]).serie.id, "make");
});

test("platform series outrank generic Gradle when their evidence ties", () => {
    const registry = createDefaultSerieRegistry();
    assert.equal(top(registry, ["AndroidManifest.xml", "build.gradle"]).serie.id, "android");
    const androidFiles = ["AndroidManifest.xml", "build.gradle", "settings.gradle", "gradle.properties", "gradlew"];
    const android = top(registry, androidFiles);
    assert.equal(android.serie.id, "android");
    assert.equal(android.score, 5);
    assert.equal(registry.detect(androidFiles).find(item => item.serie.id === "gradle")?.score, 5);
    assert.equal(top(registry, ["Podfile"]).serie.id, "ios");
    const ios = top(registry, ["Podfile", "App.xcodeproj", "App.xcworkspace"]);
    assert.equal(ios.serie.id, "ios");
    assert.equal(ios.score, 5);
    assert.equal(top(registry, ["Package.swift"]).serie.id, "ios");
    assert.equal(top(registry, ["App.xcodeproj"]).serie.id, "ios");
});

test("sorts deterministically, omits zero scores and applies limits", () => {
    const same = new SerieRegistry({ definitions: [
        definition("zeta", { markers: [marker("shared")] }),
        definition("alpha", { markers: [marker("shared")] }),
        definition("beta", { markers: [marker("shared")] }),
    ] });
    assert.deepEqual(same.detect(["shared"]).map(item => item.serie.id), ["alpha", "beta", "zeta"]);
    const priority = new SerieRegistry({ definitions: [
        definition("low", { markers: [marker("shared")], priority: 10 }),
        definition("high", { markers: [marker("shared")], priority: 90 }),
    ] });
    assert.deepEqual(priority.detect(["shared"]).map(item => item.serie.id), ["high", "low"]);
    const scored = new SerieRegistry({ definitions: [
        definition("single", { markers: [marker("a")] }),
        definition("double", { markers: [marker("b"), marker("c")] }),
    ] });
    assert.deepEqual(scored.detect(["a", "b", "c"]).map(item => item.serie.id), ["double", "single"]);
    assert.equal(scored.detect(["missing"]).length, 0);
    assert.equal(scored.detect([]).length, 0);
    assert.equal(scored.detect(["a", "b", "c"], { maxResults: 1 }).length, 1);
    assert.equal(scored.detect(["a", "b", "c"], { maxResults: 0 }).length, 0);
    const bounded = new SerieRegistry({ definitions: [definition("a", { markers: [marker("x")] }), definition("b", { markers: [marker("x")] })], maxResults: 1 });
    assert.equal(bounded.detect(["x"]).length, 1);
    assert.equal(bounded.detect(["x"], { maxResults: 2 }).length, 2);
    const before = scored.version;
    scored.detect(["a", "b", "c"]);
    assert.equal(scored.version, before);
    const best = scored.best(["a", "b", "c"]);
    assert.ok(best instanceof Optional);
    assert.equal(best.get().serie.id, "double");
    assert.equal(scored.best(["missing"]).isEmpty(), true);
    assert.equal(scored.best([]).isEmpty(), true);
});

test("rejects malformed detection paths and maxResults", () => {
    const registry = createDefaultSerieRegistry();
    for (const files of [["../x"], ["/abs"], ["a\\b"], [""], ["a\0b"], ["./x"], ["a//b"], ["C:/x"]]) {
        assert.throws(() => registry.detect(files), TypeError);
    }
    assert.throws(() => registry.detect(null as unknown as readonly string[]), TypeError);
    assert.throws(() => registry.detect([42] as unknown as readonly string[]), TypeError);
    assert.throws(() => registry.detect(["ok"], { maxResults: -1 }), TypeError);
    assert.throws(() => registry.detect(["ok"], { maxResults: 1.5 }), TypeError);
    assert.throws(() => new SerieRegistry({ maxResults: -1 }), TypeError);
    assert.throws(() => new SerieRegistry({ maxResults: 1.5 }), TypeError);
});

test("matches exact, prefix and suffix evidence with defined semantics", () => {
    const registry = new SerieRegistry({ definitions: [
        definition("exact", { markers: [marker("Makefile")] }),
        definition("prefix", { markers: [marker("packages/", "prefix")] }),
        definition("suffix", { markers: [marker(".xcodeproj", "suffix")] }),
    ] });
    assert.equal(top(registry, ["Makefile"]).serie.id, "exact");
    assert.equal(registry.detect(["dir/Makefile"]).length, 0);
    assert.equal(registry.detect(["Makefile.bak"]).length, 0);
    assert.equal(top(registry, ["packages"]).matched[0]?.path, "packages");
    assert.equal(top(registry, ["packages"]).serie.id, "prefix");
    assert.equal(top(registry, ["packages/app/package.json"]).serie.id, "prefix");
    assert.equal(registry.detect(["packages2/app"]).length, 0);
    assert.equal(registry.detect(["lib/packages/app"]).length, 0);
    assert.equal(top(registry, ["App.xcodeproj"]).serie.id, "suffix");
    assert.equal(top(registry, ["ios/App.xcodeproj"]).serie.id, "suffix");
    assert.equal(registry.detect(["App.xcodeproj/contents"]).length, 0);
    assert.equal(registry.detect(["App.xcodeproj.bak"]).length, 0);
});

test("freezes detections and their nested values", () => {
    const detection = top(createDefaultSerieRegistry(), ["package.json", "package-lock.json"]);
    assert.equal(Object.isFrozen(detection), true);
    assert.equal(Object.isFrozen(detection.serie), true);
    assert.equal(Object.isFrozen(detection.matched), true);
    assert.equal(Object.isFrozen(detection.evidence), true);
    assert.equal(Object.isFrozen(detection.serie.markers), true);
    assert.equal(Object.isFrozen(detection.serie.markers[0]), true);
    assert.equal(Object.isFrozen(detection.serie.capabilities), true);
    assert.equal(Object.isFrozen(detection.serie.steps), true);
    assert.equal(Object.isFrozen(detection.serie.steps[0]), true);
    assert.throws(() => (detection.matched as SerieMarker[]).push(marker("x")), TypeError);
    assert.throws(() => (detection.evidence as string[]).push("x"), TypeError);
});

test("project index exposes the serie namespace", () => {
    assert.equal(typeof serie.createDefaultSerieRegistry, "function");
    assert.equal(serie.serieDefinitions.length, 8);
    const registry = serie.createDefaultSerieRegistry();
    assert.ok(registry instanceof serie.SerieRegistry);
    assert.equal(registry.detect(["pom.xml"])[0]?.serie.id, "maven");
});

test("built-in definitions expose the declared evidence and priorities", () => {
    assert.deepEqual(serieDefinitions.map(item => item.id), ["npm", "pnpm", "node", "maven", "gradle", "make", "android", "ios"]);
    const byId = (id: string): SerieDefinition => {
        const found = serieDefinitions.find(item => item.id === id);
        if (found === undefined) throw new Error(`missing definition ${id}`);
        return found;
    };
    assert.equal(byId("android").priority, 60);
    assert.equal(byId("ios").priority, 60);
    assert.equal(byId("gradle").priority, 40);
    assert.ok(byId("android").priority > byId("gradle").priority);
    assert.ok(byId("ios").priority > byId("gradle").priority);
    assert.deepEqual(byId("npm").markers.map(item => `${item.path}:${item.match}:${item.weight}`), [
        "package.json:exact:2",
        "package-lock.json:exact:2",
        "npm-shrinkwrap.json:exact:1",
    ]);
    assert.deepEqual(byId("ios").markers.map(item => `${item.path}:${item.match}:${item.weight}`), [
        "Podfile:exact:2",
        "Package.swift:exact:1",
        ".xcodeproj:suffix:2",
        ".xcworkspace:suffix:1",
    ]);
    assert.equal(byId("android").capabilities.includes("package"), true);
    assert.equal(byId("ios").capabilities.includes("bundle"), true);
    assert.equal(Object.isFrozen(serieDefinitions), true);
    assert.equal(serieDefinitions.every(item => Object.isFrozen(item)), true);
    const first = createDefaultSerieRegistry();
    const second = createDefaultSerieRegistry();
    first.unregister("npm");
    assert.equal(first.find("npm").isEmpty(), true);
    assert.equal(second.find("npm").isPresent(), true);
});
