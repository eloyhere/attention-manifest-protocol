import assert from "node:assert/strict";
import test from "node:test";
import { Optional } from "semantic-typescript";
import { emptyEnvironment, mergeEnvironment, validateEnvironment } from "../environment.ts";
import type { EnvironmentDependency, ProjectEnvironment } from "../environment.ts";
import { createDefaultProjectKindRegistry, projectKindDefinitions } from "./builtins.ts";
import { ProjectKindRegistry } from "./registry.ts";
import type { ProjectKindRegistryOptions } from "./registry.ts";
import type { ProjectKindDefinition, ProjectKindMatch, ProjectMarker } from "./types.ts";

const marker = (path: string, match: ProjectMarker["match"] = "exact", weight = 1): ProjectMarker => ({
    path,
    match,
    weight,
    label: `${match}:${path}`,
});

const environmentOf = (overrides: Partial<ProjectEnvironment> = {}): ProjectEnvironment => ({
    variables: {},
    paths: [],
    dependencies: [],
    ...overrides,
});

const definition = (id: string, overrides: Partial<ProjectKindDefinition> = {}): ProjectKindDefinition => ({
    id,
    displayName: id.toUpperCase(),
    language: id,
    markers: [marker(`${id}.marker`)],
    environment: emptyEnvironment(),
    priority: 50,
    ...overrides,
});

const top = (registry: ProjectKindRegistry, files: readonly string[]): ProjectKindMatch => {
    const match = registry.detect(files)[0];
    if (match === undefined) throw new Error(`expected a match for ${files.join(", ")}`);
    return match;
};

const byId = (id: string): ProjectKindDefinition => {
    const found = projectKindDefinitions.find(item => item.id === id);
    if (found === undefined) throw new Error(`missing definition ${id}`);
    return found;
};

test("registers definitions and returns isolated snapshots", () => {
    const registry = new ProjectKindRegistry();
    const registered = registry.register(definition("alpha"));
    assert.equal(registered.id, "alpha");
    assert.equal(Object.isFrozen(registered), true);
    assert.ok(registry.find("alpha") instanceof Optional);
    assert.equal(registry.find("alpha").get().id, "alpha");
    assert.equal(registry.find("missing").isEmpty(), true);
    assert.equal(registry.find(42 as unknown as string).isEmpty(), true);
    assert.equal(registry.requireKind("alpha").id, "alpha");
    assert.throws(() => registry.requireKind("missing"), /unknown project kind/);
    const list = registry.list();
    assert.equal(Object.isFrozen(list), true);
    assert.throws(() => (list as ProjectKindDefinition[]).push(definition("beta")), TypeError);
    assert.deepEqual(registry.list().map(item => item.id), ["alpha"]);
    const snapshot = registry.snapshot();
    assert.equal(snapshot.epoch, 1);
    assert.deepEqual(snapshot.definitions.map(item => item.id), ["alpha"]);
    assert.equal(Object.isFrozen(snapshot), true);
    assert.equal(Object.isFrozen(snapshot.definitions), true);
    assert.equal(registry.version, 1);
    assert.equal(registry.epoch, 1);
});

test("rejects invalid definitions", () => {
    const registry = new ProjectKindRegistry();
    const invalid: readonly ProjectKindDefinition[] = [
        definition(""),
        definition("bad id"),
        definition("Bad"),
        definition("bad/id"),
        definition("good", { displayName: " " }),
        definition("good", { language: "" }),
        definition("good", { markers: [] }),
        definition("good", { markers: [] as unknown as readonly ProjectMarker[] }),
        definition("good", { markers: [marker("m", "exact", 0)] }),
        definition("good", { markers: [marker("m", "exact", 4)] }),
        definition("good", { markers: [marker("m", "exact", 1.5)] }),
        definition("good", { markers: [{ ...marker("m"), label: " " }] }),
        definition("good", { markers: [marker("")] }),
        definition("good", { markers: [marker("/abs")] }),
        definition("good", { markers: [marker("../x")] }),
        definition("good", { markers: [marker("a\\b")] }),
        definition("good", { markers: [marker("m"), marker("m")] }),
        definition("good", { markers: [marker("m", "glob" as ProjectMarker["match"])] }),
        definition("good", { environment: environmentOf({ variables: { lowercase: "x" } }) }),
        definition("good", { environment: environmentOf({ variables: { OK: 42 as unknown as string } }) }),
        definition("good", { environment: environmentOf({ paths: ["../x"] }) }),
        definition("good", { environment: environmentOf({ paths: ["/abs"] }) }),
        definition("good", { environment: environmentOf({ paths: ["a\\b"] }) }),
        definition("good", { environment: undefined as unknown as ProjectEnvironment }),
        definition("good", { environment: environmentOf({ dependencies: [{ id: "x", scope: "invalid" as EnvironmentDependency["scope"] }] }) }),
        definition("good", { environment: environmentOf({ dependencies: [{ id: "", scope: "build" }] }) }),
        definition("good", { priority: -1 }),
        definition("good", { priority: 101 }),
        definition("good", { priority: 1.5 }),
        definition("good", { notes: 42 as unknown as string }),
    ];
    for (const candidate of invalid) assert.throws(() => registry.register(candidate), TypeError);
    assert.equal(registry.list().length, 0);
    assert.equal(registry.version, 0);
    const valid = registry.register(definition("valid", { markers: [marker("m", "exact"), marker("m", "suffix")] }));
    assert.equal(valid.markers.length, 2);
});

test("registerMany is atomic and preserves registration order", () => {
    const registry = new ProjectKindRegistry();
    registry.register(definition("base"));
    const epoch = registry.epoch;
    assert.throws(() => registry.registerMany([definition("a"), definition("b", { markers: [] })]), TypeError);
    assert.deepEqual(registry.list().map(item => item.id), ["base"]);
    assert.equal(registry.epoch, epoch);
    assert.throws(() => registry.registerMany([definition("a"), definition("a")]), /already registered/);
    assert.deepEqual(registry.list().map(item => item.id), ["base"]);
    assert.throws(() => registry.registerMany([definition("base")]), /already registered/);
    assert.equal(registry.epoch, epoch);
    const registered = registry.registerMany([definition("a"), definition("b")]);
    assert.deepEqual(registered.map(item => item.id), ["a", "b"]);
    assert.deepEqual(registry.list().map(item => item.id), ["base", "a", "b"]);
    assert.equal(registry.epoch, epoch + 1);
    assert.equal(Object.isFrozen(registered), true);
    const unchanged = registry.epoch;
    assert.deepEqual(registry.registerMany([]), []);
    assert.equal(registry.epoch, unchanged);
    assert.equal(new ProjectKindRegistry({ definitions: [definition("x"), definition("y")] }).epoch, 1);
});

test("rejects duplicate identifiers and retires unregistered identifiers", () => {
    const registry = new ProjectKindRegistry({ definitions: [definition("a"), definition("b")] });
    assert.throws(() => registry.register(definition("a")), /already registered/);
    const epoch = registry.epoch;
    assert.equal(registry.unregister("a"), true);
    assert.equal(registry.epoch, epoch + 1);
    assert.equal(registry.version, registry.epoch);
    assert.equal(registry.unregister("a"), false);
    assert.equal(registry.unregister("missing"), false);
    assert.equal(registry.epoch, epoch + 1);
    assert.throws(() => registry.register(definition("a")), /retired/);
    assert.throws(() => registry.registerMany([definition("a")]), /retired/);
    assert.deepEqual(registry.list().map(item => item.id), ["b"]);
    assert.throws(() => registry.register(definition("A")), /invalid project kind id/);
});

test("detects each built-in project kind from representative evidence", () => {
    const registry = createDefaultProjectKindRegistry();
    const cases: readonly { readonly files: readonly string[]; readonly id: string; readonly score: number }[] = [
        { files: ["go.mod", "go.sum"], id: "go", score: 4 },
        { files: ["main.tex", "refs.bib"], id: "tex", score: 3 },
        { files: ["notes.txt"], id: "text", score: 2 },
        { files: ["artwork.psd"], id: "photoshop", score: 2 },
        { files: ["drawing.dwg"], id: "cad", score: 2 },
        { files: ["scene.max"], id: "max3d", score: 2 },
        { files: ["part.sldprt"], id: "solidworks", score: 2 },
    ];
    for (const item of cases) {
        const match = registry.best(item.files);
        assert.equal(match.isPresent(), true, item.id);
        assert.equal(match.get().kind.id, item.id);
        assert.equal(match.get().score, item.score);
    }
    assert.equal(registry.best(["notes.txt", "README"]).get().kind.id, "text");
    assert.equal(registry.best(["notes.txt", "README"]).get().score, 3);
    assert.equal(registry.best(["missing.bin"]).isEmpty(), true);
    assert.equal(registry.best([]).isEmpty(), true);
});

test("reports matched markers and first evidence in declaration order", () => {
    const registry = createDefaultProjectKindRegistry();
    const go = registry.detect(["go.sum", "go.mod"]).find(item => item.kind.id === "go");
    assert.ok(go);
    assert.deepEqual(go.matched.map(item => item.path), ["go.mod", "go.sum"]);
    assert.deepEqual(go.evidence, ["go.mod", "go.sum"]);
    assert.equal(go.score, 4);
    const tex = top(registry, ["main.tex", "refs.bib"]);
    assert.deepEqual(tex.matched.map(item => item.path), [".tex", ".bib"]);
    assert.deepEqual(tex.evidence, ["main.tex", "refs.bib"]);
});

test("sorts by score, priority and identifier and applies limits", () => {
    const ties = new ProjectKindRegistry({ definitions: [
        definition("zeta", { markers: [marker("shared")] }),
        definition("alpha", { markers: [marker("shared")] }),
        definition("beta", { markers: [marker("shared")] }),
    ] });
    assert.deepEqual(ties.detect(["shared"]).map(item => item.kind.id), ["alpha", "beta", "zeta"]);
    const priorities = new ProjectKindRegistry({ definitions: [
        definition("low", { markers: [marker("shared")], priority: 10 }),
        definition("high", { markers: [marker("shared")], priority: 90 }),
    ] });
    assert.deepEqual(priorities.detect(["shared"]).map(item => item.kind.id), ["high", "low"]);
    const scores = new ProjectKindRegistry({ definitions: [
        definition("single", { markers: [marker("a")] }),
        definition("double", { markers: [marker("b"), marker("c")] }),
    ] });
    assert.deepEqual(scores.detect(["a", "b", "c"]).map(item => item.kind.id), ["double", "single"]);
    assert.equal(scores.detect(["missing"]).length, 0);
    assert.equal(scores.detect([]).length, 0);
    assert.equal(scores.detect(["a", "b", "c"], { maxResults: 1 }).length, 1);
    assert.equal(scores.detect(["a", "b", "c"], { maxResults: 0 }).length, 0);
    const bounded = new ProjectKindRegistry({ definitions: [
        definition("a", { markers: [marker("x")] }),
        definition("b", { markers: [marker("x")] }),
    ], maxResults: 1 });
    assert.equal(bounded.detect(["x"]).length, 1);
    assert.equal(bounded.detect(["x"], { maxResults: 2 }).length, 2);
    const before = scores.epoch;
    scores.detect(["a", "b", "c"]);
    scores.best(["a", "b", "c"]);
    assert.equal(scores.epoch, before);
    assert.ok(scores.best(["a", "b", "c"]) instanceof Optional);
    assert.equal(scores.best(["a", "b", "c"]).get().kind.id, "double");
    assert.equal(scores.best(["missing"]).isEmpty(), true);
});

test("rejects malformed detection paths and options", () => {
    const registry = createDefaultProjectKindRegistry();
    for (const files of [["../x"], ["/abs"], ["a\\b"], [""], ["a\0b"], ["./x"], ["a//b"], ["C:/x"], ["."]]) {
        assert.throws(() => registry.detect(files), TypeError);
    }
    assert.throws(() => registry.detect(null as unknown as readonly string[]), TypeError);
    assert.throws(() => registry.detect([42] as unknown as readonly string[]), TypeError);
    assert.throws(() => registry.detect(["go.mod"], { maxResults: -1 }), TypeError);
    assert.throws(() => registry.detect(["go.mod"], { maxResults: 1.5 }), TypeError);
    assert.throws(() => registry.detect(["go.mod"], null as unknown as { readonly maxResults?: number }), TypeError);
    assert.throws(() => new ProjectKindRegistry({ maxResults: -1 }), TypeError);
    assert.throws(() => new ProjectKindRegistry({ maxResults: 1.5 }), TypeError);
    assert.throws(() => new ProjectKindRegistry(null as unknown as ProjectKindRegistryOptions), TypeError);
});

test("matches exact, prefix and suffix markers with defined semantics", () => {
    const registry = new ProjectKindRegistry({ definitions: [
        definition("exact", { markers: [marker("Makefile")] }),
        definition("prefix", { markers: [marker("packages/", "prefix", 2)] }),
        definition("suffix", { markers: [marker(".sldprt", "suffix", 2)] }),
    ] });
    assert.equal(top(registry, ["Makefile"]).kind.id, "exact");
    assert.equal(registry.detect(["dir/Makefile"]).length, 0);
    assert.equal(registry.detect(["Makefile.bak"]).length, 0);
    assert.equal(top(registry, ["packages"]).kind.id, "prefix");
    assert.equal(top(registry, ["packages"]).matched[0]?.path, "packages");
    assert.equal(top(registry, ["packages/app/package.json"]).kind.id, "prefix");
    assert.equal(registry.detect(["packages2/app"]).length, 0);
    assert.equal(registry.detect(["lib/packages/app"]).length, 0);
    assert.equal(top(registry, ["App.sldprt"]).kind.id, "suffix");
    assert.equal(top(registry, ["parts/App.sldprt"]).kind.id, "suffix");
    assert.equal(registry.detect(["App.sldprt.bak"]).length, 0);
});

test("freezes definitions, environments and detections", () => {
    const registry = createDefaultProjectKindRegistry();
    const go = registry.requireKind("go");
    assert.equal(Object.isFrozen(go), true);
    assert.equal(Object.isFrozen(go.markers), true);
    assert.equal(Object.isFrozen(go.markers[0]), true);
    assert.equal(Object.isFrozen(go.environment), true);
    assert.equal(Object.isFrozen(go.environment.variables), true);
    assert.equal(Object.isFrozen(go.environment.paths), true);
    assert.equal(Object.isFrozen(go.environment.dependencies), true);
    assert.equal(Object.isFrozen(go.environment.dependencies[0]), true);
    assert.throws(() => { (go.environment.variables as Record<string, string>).GOFLAGS = "off"; }, TypeError);
    const match = top(registry, ["go.mod", "go.sum"]);
    assert.equal(Object.isFrozen(match), true);
    assert.equal(Object.isFrozen(match.kind), true);
    assert.equal(Object.isFrozen(match.matched), true);
    assert.equal(Object.isFrozen(match.evidence), true);
    assert.throws(() => (match.matched as ProjectMarker[]).push(marker("x")), TypeError);
    assert.throws(() => (match.evidence as string[]).push("x"), TypeError);
});

test("does not leak caller-owned environment state", () => {
    const variables: Record<string, string> = { FLAG: "on" };
    const environment: ProjectEnvironment = {
        variables,
        paths: ["src"],
        dependencies: [{ id: "go", scope: "build" }],
    };
    const registry = new ProjectKindRegistry();
    registry.register(definition("isolated", { environment }));
    variables.FLAG = "off";
    (environment.paths as string[]).push("extra");
    (environment.dependencies as EnvironmentDependency[]).push({ id: "other", scope: "dev" });
    const stored = registry.requireKind("isolated");
    assert.equal(stored.environment.variables.FLAG, "on");
    assert.deepEqual(stored.environment.paths, ["src"]);
    assert.equal(stored.environment.dependencies.length, 1);
    assert.notEqual(stored.environment.variables, variables);
});

test("mergeEnvironment overlays variables and deduplicates paths and dependencies", () => {
    const base: ProjectEnvironment = {
        variables: { A: "1", B: "2" },
        paths: ["src", "docs"],
        dependencies: [
            { id: "go", scope: "build", manager: "go" },
            { id: "latexmk", scope: "build" },
        ],
    };
    const merged = mergeEnvironment(base, {
        variables: { B: "3", C: "4" },
        paths: ["docs", "out", "src"],
        dependencies: [
            { id: "go", scope: "build", version: ">=1.22" },
            { id: "go", scope: "tool" },
        ],
    });
    assert.deepEqual(merged.variables, { A: "1", B: "3", C: "4" });
    assert.deepEqual(merged.paths, ["src", "docs", "out"]);
    assert.deepEqual(merged.dependencies.map(item => `${item.id}:${item.scope}`), ["go:build", "latexmk:build", "go:tool"]);
    assert.equal(merged.dependencies[0]?.version, ">=1.22");
    assert.equal(merged.dependencies[0]?.manager, undefined);
    assert.equal(base.variables.B, "2");
    assert.deepEqual(base.paths, ["src", "docs"]);
    assert.equal(base.dependencies.length, 2);
    assert.equal(base.dependencies[0]?.manager, "go");
    assert.equal(Object.isFrozen(merged), true);
    assert.equal(Object.isFrozen(merged.variables), true);
    assert.equal(Object.isFrozen(merged.paths), true);
    assert.equal(Object.isFrozen(merged.dependencies), true);
    assert.equal(Object.isFrozen(merged.dependencies[0]), true);
    const untouched = mergeEnvironment(emptyEnvironment(), {});
    assert.deepEqual(untouched.variables, {});
    assert.deepEqual(untouched.paths, []);
    assert.deepEqual(untouched.dependencies, []);
});

test("rejects malformed environments", () => {
    assert.doesNotThrow(() => validateEnvironment(emptyEnvironment()));
    assert.doesNotThrow(() => validateEnvironment({ variables: {}, paths: ["."], dependencies: [] }));
    assert.doesNotThrow(() => validateEnvironment({ variables: {}, paths: ["src", "a/b"], dependencies: [{ id: "go", scope: "build", manager: "go", version: ">=1.22", optional: false }] }));
    const invalid: readonly ProjectEnvironment[] = [
        { variables: { lowercase: "x" }, paths: [], dependencies: [] },
        { variables: { "1A": "x" }, paths: [], dependencies: [] },
        { variables: {}, paths: [".."], dependencies: [] },
        { variables: {}, paths: ["../x"], dependencies: [] },
        { variables: {}, paths: ["/abs"], dependencies: [] },
        { variables: {}, paths: ["a\\b"], dependencies: [] },
        { variables: {}, paths: [""], dependencies: [] },
        { variables: {}, paths: ["a//b"], dependencies: [] },
        { variables: {}, paths: [], dependencies: [{ id: " ", scope: "build" }] },
        { variables: {}, paths: [], dependencies: [{ id: "x", scope: "invalid" as EnvironmentDependency["scope"] }] },
        { variables: {}, paths: [], dependencies: [{ id: "x", scope: "build", version: 1 as unknown as string }] },
        { variables: {}, paths: [], dependencies: [{ id: "x", scope: "build", optional: "yes" as unknown as boolean }] },
    ];
    for (const candidate of invalid) assert.throws(() => validateEnvironment(candidate), TypeError);
});

test("exposes seven built-in definitions with valid environments", () => {
    assert.equal(projectKindDefinitions.length, 7);
    assert.equal(Object.isFrozen(projectKindDefinitions), true);
    assert.deepEqual(projectKindDefinitions.map(item => item.id), ["go", "tex", "text", "photoshop", "cad", "max3d", "solidworks"]);
    for (const item of projectKindDefinitions) {
        assert.doesNotThrow(() => validateEnvironment(item.environment));
        assert.equal(item.language, item.id);
        assert.ok(item.markers.length > 0);
        assert.equal(Object.isFrozen(item), true);
        assert.equal(Object.isFrozen(item.environment.variables), true);
        assert.equal(Object.isFrozen(item.environment.paths), true);
        assert.equal(Object.isFrozen(item.environment.dependencies), true);
    }
});

test("createDefaultProjectKindRegistry returns an independent seven-kind registry", () => {
    const first = createDefaultProjectKindRegistry();
    const second = createDefaultProjectKindRegistry();
    assert.equal(first.list().length, 7);
    assert.equal(second.list().length, 7);
    assert.equal(first.epoch, 1);
    assert.equal(second.epoch, 1);
    assert.equal(first.unregister("go"), true);
    assert.equal(first.list().length, 6);
    assert.equal(first.find("go").isEmpty(), true);
    assert.equal(second.find("go").isPresent(), true);
    assert.deepEqual(second.list().map(item => item.id), ["go", "tex", "text", "photoshop", "cad", "max3d", "solidworks"]);
});

test("declares the documented markers, priorities and environments", () => {
    assert.deepEqual(byId("go").markers.map(item => `${item.path}:${item.match}:${item.weight}`), [
        "go.mod:exact:2",
        "go.sum:exact:2",
        "go.work:exact:1",
        ".go:suffix:1",
    ]);
    assert.deepEqual(byId("tex").markers.map(item => `${item.path}:${item.match}:${item.weight}`), [
        ".tex:suffix:2",
        "latexmkrc:exact:1",
        ".latexmkrc:exact:1",
        ".bib:suffix:1",
    ]);
    assert.deepEqual(byId("text").markers.map(item => `${item.path}:${item.match}:${item.weight}`), [
        ".txt:suffix:2",
        ".text:suffix:1",
        "README:exact:1",
        "LICENSE:exact:1",
    ]);
    assert.deepEqual(byId("photoshop").markers.map(item => `${item.path}:${item.match}:${item.weight}`), [".psd:suffix:2", ".psb:suffix:1", ".psdt:suffix:1"]);
    assert.deepEqual(byId("cad").markers.map(item => `${item.path}:${item.match}:${item.weight}`), [".dwg:suffix:2", ".dxf:suffix:2", ".dwt:suffix:1"]);
    assert.deepEqual(byId("max3d").markers.map(item => `${item.path}:${item.match}:${item.weight}`), [".max:suffix:2", ".3ds:suffix:1", ".mat:suffix:1"]);
    assert.deepEqual(byId("solidworks").markers.map(item => `${item.path}:${item.match}:${item.weight}`), [".sldprt:suffix:2", ".sldasm:suffix:2", ".slddrw:suffix:1", ".sldtpl:suffix:1"]);
    assert.deepEqual(byId("go").environment.variables, { GO111MODULE: "on", GOFLAGS: "-mod=readonly" });
    assert.deepEqual(byId("go").environment.paths, ["cmd", "internal", "pkg", "bin"]);
    assert.deepEqual(byId("go").environment.dependencies, [{ id: "go", scope: "build", manager: "go" }]);
    assert.deepEqual(byId("tex").environment.variables, { TEXINPUTS: ".:./styles//:" });
    assert.deepEqual(byId("tex").environment.paths, ["sections", "figures", "styles", "build"]);
    assert.deepEqual(byId("tex").environment.dependencies, [
        { id: "latexmk", scope: "build", manager: "tlmgr" },
        { id: "bibtex", scope: "build", optional: true },
    ]);
    assert.deepEqual(byId("text").environment.variables, {});
    assert.deepEqual(byId("text").environment.paths, ["."]);
    assert.deepEqual(byId("text").environment.dependencies, []);
    assert.deepEqual(byId("photoshop").environment.variables, { PHOTOSHOP_SCRIPTS: "./scripts" });
    assert.deepEqual(byId("photoshop").environment.paths, ["assets", "exports", "scripts"]);
    assert.deepEqual(byId("cad").environment.variables, { ACAD_SUPPORT_PATH: "./support" });
    assert.deepEqual(byId("max3d").environment.variables, { ADSK_3DSMAX_VERSION: "2025" });
    assert.deepEqual(byId("solidworks").environment.variables, { SW_TEMPLATES: "./templates" });
    assert.equal(byId("cad").environment.dependencies[0]?.optional, true);
    assert.equal(byId("go").priority, 50);
    assert.equal(byId("tex").priority, 40);
    assert.equal(byId("text").priority, 5);
    for (const id of ["photoshop", "cad", "max3d", "solidworks"]) assert.equal(byId(id).priority, 30);
});
