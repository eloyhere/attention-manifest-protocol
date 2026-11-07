/**
 * Boundary tests for the project model, its registries and the agent interface.
 *
 * The suite pins the contracts a host has to rely on: declarative environment
 * validation and merge semantics, plan/describe determinism, project
 * environment versioning, kind/serie/language registry retirement and ranking,
 * the kind bridge, the declarative agent surface and the gateway dispatch
 * ladder. It never reads the file system, spawns a process or mutates source.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { Optional } from "semantic-typescript";
import { AgentGateway, GatewayError } from "../agent/gateway.ts";
import type { GatewayCallRecord, GatewayHandler } from "../agent/gateway.ts";
import {
    SURFACE_MODULES, SURFACE_PREFIX, assertBinding, assertModelParameters, createAgentSurface, describeSurface, findModule,
    findTool,
} from "../agent/surface.ts";
import type { AgentBinding, AgentSurface, SurfaceTier } from "../agent/surface.ts";
import { builtinLanguages, createDefaultLanguageRegistry } from "../file/language/builtins.ts";
import { LanguageRegistry } from "../file/language/registry.ts";
import type { LanguageDefinition } from "../file/language/types.ts";
import type { ParsedOutlineNode } from "../file/outline.ts";
import { Project } from "../project/core.ts";
import { describeEnvironment, emptyEnvironment, mergeEnvironment, planEnvironment, validateEnvironment } from "../project/environment.ts";
import type { EnvironmentDependency, ProjectEnvironment } from "../project/environment.ts";
import { applyProjectKind, createProjectFromKind } from "../project/kinds/bridge.ts";
import { createDefaultProjectKindRegistry, projectKindDefinitions } from "../project/kinds/builtins.ts";
import { definition as goKind } from "../project/kinds/go.ts";
import { ProjectKindRegistry } from "../project/kinds/registry.ts";
import type { ProjectKindDefinition, ProjectKindMatch, ProjectMarker } from "../project/kinds/types.ts";
import { createDefaultSerieRegistry, serieDefinitions } from "../project/serie/builtins.ts";
import { SerieRegistry } from "../project/serie/registry.ts";
import type { SerieCapability, SerieDefinition, SerieKind, SerieMarker, SerieStep } from "../project/serie/types.ts";
import type { ProjectOptions } from "../project/types.ts";
import { WorkspaceError } from "../workspace/types.ts";

const scope = { tenantId: "tenant-a", rootId: "root-1" } as const;

const makeProject = (options: Omit<ProjectOptions, "tenantId" | "rootId"> = {}): Project =>
    new Project({ ...scope, clock: () => "2026-01-01T00:00:00.000Z", ...options });

const environmentOf = (overrides: Partial<ProjectEnvironment> = {}): ProjectEnvironment => ({
    variables: {},
    paths: [],
    dependencies: [],
    ...overrides,
});

const workspaceCode = (code: WorkspaceError["code"]) => (error: unknown): boolean =>
    error instanceof WorkspaceError && error.code === code;

const gatewayCode = (code: GatewayError["code"]) => (error: unknown): boolean =>
    error instanceof GatewayError && error.code === code;

// ---------------------------------------------------------------------------
// 1. environment validation
// ---------------------------------------------------------------------------

test("validateEnvironment rejects malformed variable names and non-string values", () => {
    assert.doesNotThrow(() => validateEnvironment(emptyEnvironment()));
    assert.doesNotThrow(() => validateEnvironment(environmentOf({ variables: { _PRIVATE: "x", A1: "y", UNDER_SCORE_2: "" } })));

    const invalidVariables: readonly Record<string, string>[] = [
        { lowercase: "x" },
        { "1LEADING": "x" },
        { "": "x" },
        { "WITH-DASH": "x" },
        { "WITH SPACE": "x" },
    ];
    for (const variables of invalidVariables) {
        assert.throws(() => validateEnvironment(environmentOf({ variables })), TypeError);
    }
    assert.throws(() => validateEnvironment(environmentOf({ variables: { COUNT: 42 as unknown as string } })), TypeError);
    assert.throws(() => validateEnvironment(environmentOf({ variables: null as unknown as Record<string, string> })), TypeError);
    assert.throws(() => validateEnvironment(null as unknown as ProjectEnvironment), TypeError);
    assert.throws(() => validateEnvironment([] as unknown as ProjectEnvironment), TypeError);
});

test("validateEnvironment enforces canonical workspace-relative paths and allows the root", () => {
    assert.doesNotThrow(() => validateEnvironment(environmentOf({ paths: ["."] })));
    assert.doesNotThrow(() => validateEnvironment(environmentOf({ paths: ["src", "src/a", "a/b/c"] })));

    const invalidPaths: readonly string[] = [
        "/abs", "\\abs", "C:/x", "..", "../x", "a/../b", "a\\b", "", "a//b", "a/./b", "./x", "a/", " src", "src ",
        "a\0b", "a\nb",
    ];
    for (const path of invalidPaths) {
        assert.throws(() => validateEnvironment(environmentOf({ paths: [path] })), TypeError);
    }
    assert.throws(() => validateEnvironment(environmentOf({ paths: [42 as unknown as string] })), TypeError);
    assert.throws(() => validateEnvironment(environmentOf({ paths: null as unknown as readonly string[] })), TypeError);
});

test("validateEnvironment rejects bad scopes, empty versions/managers and non-boolean optional", () => {
    assert.doesNotThrow(() => validateEnvironment(environmentOf({
        dependencies: [
            { id: "go", scope: "build", manager: "go", version: ">=1.22", optional: false },
            { id: "latexmk", scope: "tool", optional: true },
        ],
    })));

    const invalidDependencies: readonly EnvironmentDependency[] = [
        { id: "", scope: "build" },
        { id: "   ", scope: "build" },
        { id: "go", scope: "deploy" as EnvironmentDependency["scope"] },
        { id: "go", scope: "Build" as EnvironmentDependency["scope"] },
        { id: "go", scope: undefined as unknown as EnvironmentDependency["scope"] },
        { id: "go", scope: "build", version: "" },
        { id: "go", scope: "build", version: "   " },
        { id: "go", scope: "build", version: 1 as unknown as string },
        { id: "go", scope: "build", manager: "" },
        { id: "go", scope: "build", manager: 7 as unknown as string },
        { id: "go", scope: "build", optional: "yes" as unknown as boolean },
        { id: "go", scope: "build", optional: 1 as unknown as boolean },
        null as unknown as EnvironmentDependency,
        "go" as unknown as EnvironmentDependency,
    ];
    for (const dependency of invalidDependencies) {
        assert.throws(() => validateEnvironment(environmentOf({ dependencies: [dependency] })), TypeError);
    }
    assert.throws(
        () => validateEnvironment(environmentOf({ dependencies: null as unknown as readonly EnvironmentDependency[] })),
        TypeError,
    );
});

// ---------------------------------------------------------------------------
// 2. merge semantics
// ---------------------------------------------------------------------------

test("mergeEnvironment overlays variables, treats empty strings as unset and dedupes paths in order", () => {
    const base = environmentOf({ variables: { A: "1", B: "2" }, paths: ["src", "docs"] });
    const patch = { variables: { B: "", C: "4", UNSET: "" }, paths: ["docs", "out", "src", "out"] };
    const merged = mergeEnvironment(base, patch);

    assert.deepEqual(merged.variables, { A: "1", B: "", C: "4", UNSET: "" });
    assert.deepEqual(Object.keys(merged.variables), ["A", "B", "C", "UNSET"]);
    assert.equal(merged.variables.UNSET, "");
    assert.deepEqual(merged.paths, ["src", "docs", "out"]);

    // Neither input is modified.
    assert.deepEqual(base.variables, { A: "1", B: "2" });
    assert.deepEqual(base.paths, ["src", "docs"]);
    assert.deepEqual(patch.variables, { B: "", C: "4", UNSET: "" });
    assert.deepEqual(patch.paths, ["docs", "out", "src", "out"]);

    // The result and every nested value are frozen.
    assert.equal(Object.isFrozen(merged), true);
    assert.equal(Object.isFrozen(merged.variables), true);
    assert.equal(Object.isFrozen(merged.paths), true);
    assert.equal(Object.isFrozen(merged.dependencies), true);
    assert.throws(() => (merged.paths as string[]).push("extra"), TypeError);
    assert.throws(() => (merged.dependencies as EnvironmentDependency[]).push({ id: "go", scope: "dev" }), TypeError);
    assert.throws(() => { (merged.variables as Record<string, string>).A = "9"; }, TypeError);

    const untouched = mergeEnvironment(emptyEnvironment(), {});
    assert.deepEqual(untouched, emptyEnvironment());
    assert.notEqual(untouched, emptyEnvironment());
});

test("mergeEnvironment replaces dependencies by id and scope in place without mutating inputs", () => {
    const base = environmentOf({
        dependencies: [
            { id: "go", scope: "build", manager: "go" },
            { id: "latexmk", scope: "build" },
            { id: "go", scope: "tool" },
        ],
    });
    const patchDependencies: readonly EnvironmentDependency[] = [
        { id: "go", scope: "build", version: ">=1.22" },
        { id: "go", scope: "tool", optional: true },
        { id: "bibtex", scope: "dev" },
    ];
    const merged = mergeEnvironment(base, { dependencies: patchDependencies });

    assert.deepEqual(merged.dependencies.map(dependency => `${dependency.id}@${dependency.scope}`),
        ["go@build", "latexmk@build", "go@tool", "bibtex@dev"]);
    assert.equal(merged.dependencies[0]?.version, ">=1.22");
    assert.equal(merged.dependencies[0]?.manager, undefined, "a replacement replaces the whole entry");
    assert.equal(merged.dependencies[2]?.optional, true);
    assert.equal(merged.dependencies[3]?.scope, "dev");

    // The base keeps its own values and order.
    assert.deepEqual(base.dependencies.map(dependency => `${dependency.id}@${dependency.scope}`),
        ["go@build", "latexmk@build", "go@tool"]);
    assert.equal(base.dependencies[0]?.manager, "go");
    assert.equal(base.dependencies[0]?.version, undefined);
    assert.equal(base.dependencies[2]?.optional, undefined);

    assert.equal(Object.isFrozen(merged.dependencies[0]), true);
    assert.equal(Object.isFrozen(merged.dependencies[3]), true);
    assert.throws(() => { (merged.dependencies[0] as unknown as { version?: string }).version = "9"; }, TypeError);
});

// ---------------------------------------------------------------------------
// 3. plan / describe
// ---------------------------------------------------------------------------

test("planEnvironment reports unset variables, missing paths and unpinned dependencies", () => {
    const environment = environmentOf({
        variables: { SET: "value", UNSET: "" },
        paths: ["src", "docs", "."],
        dependencies: [
            { id: "go", scope: "build", manager: "go" },
            { id: "latexmk", scope: "build", version: ">=1.0" },
            { id: "git", scope: "tool", optional: true },
        ],
    });
    const plan = planEnvironment(environment, { presentPaths: ["src/app/main.ts"] });

    assert.equal(plan.ready, false);
    assert.equal(plan.kind, undefined);
    assert.equal(plan.version, 0);
    assert.deepEqual(plan.gaps.map(gap => `${gap.kind}:${gap.id}`),
        ["variable:UNSET", "path:docs", "dependency:go@build"]);
    assert.equal(plan.gaps[0]?.reason, "declared but unset");
    assert.equal(plan.gaps[1]?.reason, "no project entry under this path");
    assert.equal(plan.gaps[2]?.reason, "required dependency has no version");

    // "src" is covered by a nested present path and "." is always the root.
    assert.equal(plan.gaps.some(gap => gap.id === "src"), false);
    assert.equal(plan.gaps.some(gap => gap.id === "."), false);
    // A pinned dependency produces no gap.
    assert.equal(plan.gaps.some(gap => gap.id === "latexmk@build"), false);
    // An optional dependency without a version produces no gap.
    assert.equal(plan.gaps.some(gap => gap.id === "git@tool"), false);
    assert.equal(plan.gaps.some(gap => gap.kind === "dependency" && gap.id === "go@build"), true);

    assert.equal(Object.isFrozen(plan), true);
    assert.equal(Object.isFrozen(plan.gaps), true);
    assert.equal(Object.isFrozen(plan.guidance), true);

    const ready = planEnvironment(environmentOf({ paths: ["."], dependencies: [{ id: "git", scope: "tool", optional: true }] }));
    assert.equal(ready.ready, true);
    assert.deepEqual(ready.gaps, []);
});

test("a project plan uses project metadata paths, kind and environment revision", () => {
    const project = makeProject({
        kind: "go",
        environment: {
            variables: { GOPROXY: "" },
            paths: ["src", "bin"],
            dependencies: [{ id: "go", scope: "build", manager: "go" }],
        },
    });
    project.putMetadata({ ...scope, path: "src/main.go", tags: [], ruleIds: [] });

    const plan = project.environmentPlan();
    assert.equal(plan.kind, "go");
    assert.equal(plan.version, 0);
    assert.equal(plan.ready, false);
    assert.deepEqual(plan.gaps.map(gap => `${gap.kind}:${gap.id}`),
        ["variable:GOPROXY", "path:bin", "dependency:go@build"]);

    // Registering a project entry under "bin" removes only the path gap.
    project.putMetadata({ ...scope, path: "bin/app", tags: [], ruleIds: [] });
    assert.deepEqual(project.environmentPlan().gaps.map(gap => gap.id), ["GOPROXY", "go@build"]);
});

test("plan guidance is deduplicated in order and describeEnvironment is deterministic", () => {
    const project = makeProject({
        kind: "go",
        guidance: ["  First step  ", "Second step", "First step", "   "],
        environment: {
            variables: { UNSET: "" },
            paths: ["docs"],
            dependencies: [{ id: "go", scope: "build" }],
        },
    });
    const plan = project.environmentPlan();
    assert.deepEqual(plan.guidance, [
        "First step",
        "Second step",
        "Set environment variable UNSET to the value this project requires.",
        "Create or register the path docs in the project.",
        "Pin go (build) to a version constraint.",
    ]);
    assert.equal(new Set(plan.guidance).size, plan.guidance.length);

    const first = describeEnvironment(plan);
    const second = describeEnvironment(plan);
    assert.equal(first, second);
    assert.equal(first, project.describeEnvironment());
    assert.match(first, /^# Project environment/m);
    assert.match(first, /## Next steps/);
    assert.match(first, /kind: go/);
    assert.match(first, /version: 0/);
    assert.match(first, /ready: no \(3 gaps\)/);
    assert.match(first, /- UNSET = \(unset\)/);
    assert.match(first, /- docs/);
    assert.match(first, /- go \(build\)/);
    assert.match(first, /1\. First step/);
    assert.match(first, /2\. Second step/);
    assert.match(first, /3\. Set environment variable UNSET to the value this project requires\./);
    assert.match(first, /4\. Create or register the path docs in the project\./);
    assert.match(first, /5\. Pin go \(build\) to a version constraint\./);
});

// ---------------------------------------------------------------------------
// 4. project environment writes
// ---------------------------------------------------------------------------

test("project environment writes are versioned and CAS-guarded; invalid patches leave state untouched", () => {
    const project = makeProject();
    assert.equal(project.environmentVersion, 0);
    assert.deepEqual(project.environment, emptyEnvironment());

    project.configureEnvironment({ variables: { A: "1" } }, { expectedVersion: 0 });
    assert.equal(project.environmentVersion, 1);
    assert.throws(() => project.configureEnvironment({ variables: { A: "2" } }, { expectedVersion: 0 }),
        workspaceCode("version_conflict"));
    assert.throws(() => project.setEnvironment(emptyEnvironment(), { expectedVersion: 0 }),
        workspaceCode("version_conflict"));

    const before = project.environment;
    const version = project.environmentVersion;
    assert.throws(() => project.configureEnvironment({ variables: { bad_name: "x" } }), workspaceCode("invalid_project"));
    assert.throws(() => project.configureEnvironment({ paths: ["../escape"] }), workspaceCode("invalid_project"));
    assert.throws(
        () => project.configureEnvironment({ dependencies: [{ id: "go", scope: "nope" as EnvironmentDependency["scope"] }] }),
        workspaceCode("invalid_project"),
    );
    assert.throws(
        () => project.setEnvironment({ variables: { A: "3" }, paths: ["a\\b"], dependencies: [] }),
        workspaceCode("invalid_project"),
    );
    assert.equal(project.environmentVersion, version);
    assert.equal(project.environment, before, "a rejected patch must not replace the snapshot");
    assert.equal(project.environment.variables.A, "1");

    assert.throws(() => new Project({ ...scope, environment: environmentOf({ variables: { lower: "x" } }) }),
        workspaceCode("invalid_project"));
    assert.throws(() => new Project({ tenantId: "", rootId: "root-1" }), workspaceCode("invalid_project"));
});

test("setEnvironment removes undeclared entries and project environments are immutable snapshots", () => {
    const project = makeProject({
        environment: {
            variables: { A: "1", B: "2" },
            paths: ["src"],
            dependencies: [{ id: "go", scope: "build", version: ">=1.22" }],
        },
    });
    const snapshot = project.environment;
    assert.equal(Object.isFrozen(snapshot), true);
    assert.equal(Object.isFrozen(snapshot.variables), true);
    assert.equal(Object.isFrozen(snapshot.paths), true);
    assert.equal(Object.isFrozen(snapshot.dependencies), true);
    assert.equal(Object.isFrozen(snapshot.dependencies[0]), true);
    assert.throws(() => (snapshot.paths as string[]).push("extra"), TypeError);
    assert.throws(() => (snapshot.dependencies as EnvironmentDependency[]).push({ id: "git", scope: "dev" }), TypeError);
    assert.throws(() => { (snapshot.variables as Record<string, string>).A = "9"; }, TypeError);

    const replaced = project.setEnvironment({ variables: { C: "3" }, paths: [], dependencies: [] });
    assert.deepEqual(replaced.variables, { C: "3" });
    assert.deepEqual(project.environment.paths, []);
    assert.equal(project.environment.dependencies.length, 0);
    assert.equal(project.environmentVersion, 1);

    // The earlier snapshot is still the same frozen value.
    assert.deepEqual(snapshot.variables, { A: "1", B: "2" });
    assert.deepEqual(snapshot.paths, ["src"]);
    assert.equal(snapshot.dependencies.length, 1);
});

// ---------------------------------------------------------------------------
// 5. kind registry
// ---------------------------------------------------------------------------

const kindMarker = (path: string, match: ProjectMarker["match"] = "exact", weight = 1): ProjectMarker => ({
    path,
    match,
    weight,
    label: `${match}:${path}`,
});

const kindDefinition = (id: string, overrides: Partial<ProjectKindDefinition> = {}): ProjectKindDefinition => ({
    id,
    displayName: id.toUpperCase(),
    language: id,
    markers: [kindMarker(`${id}.marker`)],
    environment: emptyEnvironment(),
    priority: 50,
    ...overrides,
});

const topKind = (registry: ProjectKindRegistry, files: readonly string[]): ProjectKindMatch => {
    const [match] = registry.detect(files);
    if (!match) throw new Error(`expected a kind match for ${files.join(", ")}`);
    return match;
};

test("kind registry registers definitions, finds Optional values and rejects duplicate ids", () => {
    assert.equal(projectKindDefinitions.length, 7);
    assert.equal(createDefaultProjectKindRegistry().list().length, 7);

    const registry = new ProjectKindRegistry({ definitions: projectKindDefinitions });
    assert.equal(registry.list().length, 7);
    const found = registry.find("go");
    assert.ok(found instanceof Optional);
    assert.equal(found.isPresent(), true);
    assert.equal(found.get().id, "go");
    assert.equal(registry.find("missing").isEmpty(), true);
    assert.equal(registry.find("GO").isEmpty(), true, "find does not normalize ids");
    assert.equal(registry.find(42 as unknown as string).isEmpty(), true);
    assert.equal(registry.requireKind("go").id, "go");
    assert.throws(() => registry.requireKind("missing"), TypeError);
    assert.throws(() => registry.register(kindDefinition("go")), /already registered/);
    assert.equal(Object.isFrozen(registry.list()), true);
});

test("kind registry rejects uppercase and malformed ids", () => {
    const registry = new ProjectKindRegistry();
    for (const id of ["Go", "GO", "go lang", "go/lang", "", " go", "go "]) {
        assert.throws(() => registry.register(kindDefinition(id)), TypeError);
    }
    assert.equal(registry.list().length, 0);
    assert.equal(registry.epoch, 0);
    assert.equal(registry.register(kindDefinition("go-1.2_x")).id, "go-1.2_x");
});

test("kind registry validates marker weights, labels and workspace paths", () => {
    const registry = new ProjectKindRegistry();
    const invalidMarkers: readonly ProjectMarker[] = [
        kindMarker("m", "exact", 0),
        kindMarker("m", "exact", 4),
        kindMarker("m", "exact", 1.5),
        { ...kindMarker("m"), label: "" },
        { ...kindMarker("m"), label: "   " },
        kindMarker(""),
        kindMarker("/abs"),
        kindMarker("../x"),
        kindMarker("a\\b"),
        kindMarker("."),
        kindMarker("a//b"),
        { ...kindMarker("m"), match: "glob" as ProjectMarker["match"] },
    ];
    for (const marker of invalidMarkers) {
        assert.throws(() => registry.register(kindDefinition("good", { markers: [marker] })), TypeError);
    }
    assert.throws(() => registry.register(kindDefinition("good", { markers: [] })), TypeError);
    assert.throws(
        () => registry.register(kindDefinition("good", { markers: [kindMarker("m"), kindMarker("m")] })),
        /duplicate project kind marker/,
    );
    assert.equal(registry.list().length, 0);

    const normalized = registry.register(kindDefinition("prefixed", { markers: [kindMarker("dir/", "prefix")] }));
    assert.equal(normalized.markers[0]?.path, "dir");
    assert.equal(topKind(registry, ["dir/file.txt"]).kind.id, "prefixed");

    const valid = registry.register(kindDefinition("good", { markers: [kindMarker("m"), kindMarker("m", "suffix")] }));
    assert.equal(valid.markers.length, 2);
});

test("kind registry enforces priority bounds, advances epochs and retires ids permanently", () => {
    const registry = new ProjectKindRegistry();
    assert.equal(registry.epoch, 0);
    assert.equal(registry.version, 0);

    assert.throws(() => registry.register(kindDefinition("bad", { priority: -1 })), TypeError);
    assert.throws(() => registry.register(kindDefinition("bad", { priority: 101 })), TypeError);
    assert.throws(() => registry.register(kindDefinition("bad", { priority: 1.5 })), TypeError);
    assert.equal(registry.epoch, 0);

    assert.equal(registry.register(kindDefinition("low", { priority: 0 })).priority, 0);
    assert.equal(registry.epoch, 1);
    assert.equal(registry.register(kindDefinition("high", { priority: 100 })).priority, 100);
    assert.equal(registry.epoch, 2);
    assert.equal(registry.version, 2);

    const registered = registry.registerMany([kindDefinition("a"), kindDefinition("b")]);
    assert.equal(registered.length, 2);
    assert.equal(registry.epoch, 3);

    assert.throws(() => registry.register(kindDefinition("low")), /already registered/);
    assert.equal(registry.epoch, 3);

    assert.equal(registry.unregister("low"), true);
    assert.equal(registry.epoch, 4);
    assert.equal(registry.version, 4);
    assert.equal(registry.unregister("low"), false);
    assert.equal(registry.unregister("missing"), false);
    assert.equal(registry.epoch, 4);
    assert.equal(registry.find("low").isEmpty(), true);
    assert.throws(() => registry.register(kindDefinition("low")), /permanently retired/);
    assert.throws(() => registry.registerMany([kindDefinition("low")]), /permanently retired/);
    assert.equal(registry.epoch, 4);
});

test("kind registry registerMany is atomic and rejects in-batch duplicates", () => {
    const registry = new ProjectKindRegistry();
    assert.throws(
        () => registry.registerMany([kindDefinition("alpha"), kindDefinition("beta", { priority: 101 })]),
        TypeError,
    );
    assert.deepEqual(registry.list(), []);
    assert.equal(registry.epoch, 0);

    assert.throws(() => registry.registerMany([kindDefinition("alpha"), kindDefinition("alpha")]), /already registered/);
    assert.deepEqual(registry.list(), []);
    assert.equal(registry.epoch, 0);

    registry.register(kindDefinition("base"));
    assert.throws(() => registry.registerMany([kindDefinition("gamma"), kindDefinition("base")]), /already registered/);
    assert.deepEqual(registry.list().map(entry => entry.id), ["base"]);
    assert.equal(registry.epoch, 1);

    const empty = registry.registerMany([]);
    assert.deepEqual(empty, []);
    assert.equal(Object.isFrozen(empty), true);
    assert.equal(registry.epoch, 1);
});

test("kind registry detection sorts by score then priority then id and omits zero scores", () => {
    const registry = new ProjectKindRegistry({ definitions: [
        kindDefinition("zeta", { markers: [kindMarker("shared")], priority: 100 }),
        kindDefinition("alpha", { markers: [kindMarker("shared")], priority: 100 }),
        kindDefinition("mid", { markers: [kindMarker("shared")], priority: 50 }),
        kindDefinition("strong", { markers: [kindMarker("shared", "exact", 2)], priority: 0 }),
    ] });
    assert.deepEqual(registry.detect(["shared"]).map(match => match.kind.id), ["strong", "alpha", "zeta", "mid"]);
    assert.equal(registry.detect(["none"]).length, 0);
    assert.equal(registry.detect([]).length, 0);

    const best = registry.best(["shared"]);
    assert.ok(best instanceof Optional);
    assert.equal(best.get().kind.id, "strong");
    assert.equal(best.get().score, 2);
    assert.equal(registry.best(["none"]).isEmpty(), true);

    assert.equal(registry.detect(["shared"], { maxResults: 2 }).length, 2);
    assert.equal(registry.detect(["shared"], { maxResults: 0 }).length, 0);
    const bounded = new ProjectKindRegistry({
        definitions: [kindDefinition("one", { markers: [kindMarker("x")] }), kindDefinition("two", { markers: [kindMarker("x")] })],
        maxResults: 1,
    });
    assert.equal(bounded.detect(["x"]).length, 1);
    assert.equal(bounded.detect(["x"], { maxResults: 2 }).length, 2);

    const epoch = registry.epoch;
    registry.detect(["shared"]);
    registry.best(["shared"]);
    assert.equal(registry.epoch, epoch, "detection must not mutate the registry");
});

test("kind registry detection rejects malformed paths and freezes its results", () => {
    const registry = new ProjectKindRegistry({ definitions: [kindDefinition("only", { markers: [kindMarker("x", "exact", 2)] })] });
    for (const files of [["../x"], ["/abs"], ["a\\b"], [""], ["."], ["a//b"], ["a\0b"], ["C:/x"]]) {
        assert.throws(() => registry.detect(files), TypeError);
    }
    assert.throws(() => registry.detect(null as unknown as readonly string[]), TypeError);
    assert.throws(() => registry.detect([42 as unknown as string]), TypeError);
    assert.throws(() => registry.detect(["x"], { maxResults: -1 }), TypeError);
    assert.throws(() => registry.detect(["x"], { maxResults: 1.5 }), TypeError);
    assert.throws(() => registry.detect(["x"], null as unknown as { readonly maxResults?: number }), TypeError);
    assert.throws(() => new ProjectKindRegistry({ maxResults: -1 }), TypeError);

    const match = topKind(registry, ["x"]);
    assert.equal(match.score, 2);
    assert.equal(Object.isFrozen(match), true);
    assert.equal(Object.isFrozen(match.kind), true);
    assert.equal(Object.isFrozen(match.matched), true);
    assert.equal(Object.isFrozen(match.evidence), true);
    assert.throws(() => (match.matched as ProjectMarker[]).push(kindMarker("y")), TypeError);
    assert.throws(() => (match.evidence as string[]).push("y"), TypeError);
    assert.throws(() => (registry.detect(["x"]) as ProjectKindMatch[]).push(match), TypeError);
});

// ---------------------------------------------------------------------------
// 6. kind bridge
// ---------------------------------------------------------------------------

test("createProjectFromKind seeds the kind environment and identifier", () => {
    const project = createProjectFromKind(goKind, scope);
    assert.equal(project.kind, "go");
    assert.equal(project.environmentVersion, 0);
    assert.deepEqual(project.environment.variables, { GO111MODULE: "on", GOFLAGS: "-mod=readonly" });
    assert.deepEqual(project.environment.paths, ["cmd", "internal", "pkg", "bin"]);
    assert.deepEqual(project.environment.dependencies, [{ id: "go", scope: "build", manager: "go" }]);
    assert.equal(Object.isFrozen(project.environment), true);
    assert.equal(Object.isFrozen(project.environment.variables), true);
    assert.notEqual(project.environment, goKind.environment);
    assert.deepEqual(goKind.environment.variables, { GO111MODULE: "on", GOFLAGS: "-mod=readonly" });
});

test("applyProjectKind preserves project overrides, including empty strings, and honours CAS", () => {
    const project = createProjectFromKind(goKind, scope);
    project.configureEnvironment({ variables: { GO111MODULE: "off", CUSTOM: "1" }, paths: ["custom"] });

    const overridden = applyProjectKind(project, goKind);
    assert.equal(overridden.variables.GO111MODULE, "off");
    assert.equal(overridden.variables.CUSTOM, "1");
    assert.equal(overridden.variables.GOFLAGS, "-mod=readonly");
    assert.deepEqual(overridden.paths, ["cmd", "internal", "pkg", "bin", "custom"]);
    assert.equal(project.environmentVersion, 2);

    project.configureEnvironment({ variables: { GO111MODULE: "" } });
    const unset = applyProjectKind(project, goKind);
    assert.equal(unset.variables.GO111MODULE, "", "an empty override still wins over the kind default");

    const version = project.environmentVersion;
    const before = project.environment;
    assert.throws(() => applyProjectKind(project, goKind, { expectedVersion: 0 }), workspaceCode("version_conflict"));
    assert.equal(project.environmentVersion, version);
    assert.equal(project.environment, before);

    // The shared kind definition is never mutated by the bridge.
    assert.equal(goKind.environment.variables.GO111MODULE, "on");
    assert.equal(applyProjectKind(project, goKind, { expectedVersion: version }).variables.GO111MODULE, "");
});

// ---------------------------------------------------------------------------
// 7. serie registry
// ---------------------------------------------------------------------------

const serieMarker = (path: string, match: SerieMarker["match"] = "exact", weight = 1): SerieMarker => ({
    path,
    match,
    weight,
    label: `${match}:${path}`,
});

const serieDefinition = (id: string, overrides: Partial<SerieDefinition> = {}): SerieDefinition => ({
    id,
    displayName: id.toUpperCase(),
    kind: "build-system",
    markers: [serieMarker(`${id}.marker`)],
    capabilities: ["build"],
    steps: [{ capability: "build", command: `build ${id}` }],
    priority: 50,
    ...overrides,
});

test("serie registry validates capabilities and steps", () => {
    const registry = new SerieRegistry();
    const invalid: readonly SerieDefinition[] = [
        serieDefinition("bad", { capabilities: [] }),
        serieDefinition("bad", { capabilities: ["deploy" as SerieCapability] }),
        serieDefinition("bad", { capabilities: ["build"], steps: [{ capability: "test", command: "npm test" }] }),
        serieDefinition("bad", { capabilities: ["build"], steps: [{ capability: "build", command: "  " }] }),
        serieDefinition("bad", { markers: [] }),
        serieDefinition("bad", { markers: [serieMarker("m", "exact", 0)] }),
        serieDefinition("bad", { markers: [serieMarker("m", "exact", 4)] }),
        serieDefinition("bad", { markers: [{ ...serieMarker("m"), label: " " }] }),
        serieDefinition("bad", { markers: [serieMarker("/abs")] }),
        serieDefinition("bad", { kind: "toolchain" as SerieKind }),
        serieDefinition("bad", { priority: 101 }),
        serieDefinition("bad", { steps: null as unknown as readonly SerieStep[] }),
    ];
    for (const candidate of invalid) {
        assert.throws(() => registry.register(candidate), TypeError);
    }
    assert.equal(registry.list().length, 0);

    const valid = registry.register(serieDefinition("valid", { capabilities: ["build", "build", "test"] }));
    assert.deepEqual(valid.capabilities, ["build", "test"]);
    assert.equal(valid.steps.length, 1);
});

test("serie registry rejects duplicate ids and retires unregistered ids", () => {
    const registry = createDefaultSerieRegistry();
    assert.equal(serieDefinitions.length, 8);
    assert.equal(registry.list().length, 8);
    assert.throws(() => registry.register(serieDefinition("npm")), /already registered/);

    const epoch = registry.epoch;
    assert.equal(registry.unregister("npm"), true);
    assert.equal(registry.epoch, epoch + 1);
    assert.equal(registry.unregister("npm"), false);
    assert.equal(registry.epoch, epoch + 1);
    assert.equal(registry.find("npm").isEmpty(), true);
    assert.equal(registry.find("NPM").isEmpty(), true);
    assert.throws(() => registry.register(serieDefinition("npm")), /permanently retired/);
    assert.throws(() => registry.registerMany([serieDefinition("npm")]), /permanently retired/);
});

test("serie detection sorts by score then priority then id and best returns an Optional", () => {
    const registry = new SerieRegistry({ definitions: [
        serieDefinition("zeta", { markers: [serieMarker("shared")], priority: 100 }),
        serieDefinition("alpha", { markers: [serieMarker("shared")], priority: 100 }),
        serieDefinition("mid", { markers: [serieMarker("shared")], priority: 50 }),
        serieDefinition("strong", { markers: [serieMarker("shared", "exact", 2)], priority: 0 }),
    ] });
    assert.deepEqual(registry.detect(["shared"]).map(detection => detection.serie.id), ["strong", "alpha", "zeta", "mid"]);
    assert.equal(registry.detect(["none"]).length, 0);

    const best = registry.best(["shared"]);
    assert.ok(best instanceof Optional);
    assert.equal(best.get().serie.id, "strong");
    assert.equal(best.get().score, 2);
    assert.equal(registry.best(["none"]).isEmpty(), true);
    assert.equal(registry.detect(["shared"], { maxResults: 2 }).length, 2);
    assert.throws(() => registry.detect(["../x"]), TypeError);

    const detection = registry.detect(["shared"])[0];
    assert.ok(detection);
    assert.equal(Object.isFrozen(detection), true);
    assert.equal(Object.isFrozen(detection.matched), true);
    assert.equal(Object.isFrozen(detection.evidence), true);
    assert.throws(() => (detection.matched as SerieMarker[]).push(serieMarker("y")), TypeError);
});

// ---------------------------------------------------------------------------
// 8. language registry
// ---------------------------------------------------------------------------

test("the builtin language catalog has 32 definitions and rejects duplicate ids, extensions and MIME types", () => {
    assert.equal(builtinLanguages.length, 32);
    assert.equal(Object.isFrozen(builtinLanguages), true);

    const registry = createDefaultLanguageRegistry();
    assert.equal(registry.list().length, 32);
    assert.equal(registry.find("markdown").isPresent(), true);

    const duplicateId: LanguageDefinition = {
        id: "markdown", displayName: "Duplicate", extensions: [".dup-md"], mimeTypes: [], support: "text",
    };
    assert.throws(() => registry.register(duplicateId), /already used/);

    const duplicateExtension: LanguageDefinition = {
        id: "custom-md", displayName: "Custom", extensions: [".md"], mimeTypes: [], support: "text",
    };
    assert.throws(() => registry.register(duplicateExtension), /extension conflict/);

    const duplicateMime: LanguageDefinition = {
        id: "custom-mime", displayName: "Custom", extensions: [".custom-mime"], mimeTypes: ["text/markdown"], support: "text",
    };
    assert.throws(() => registry.register(duplicateMime), /MIME conflict/);

    assert.equal(registry.list().length, 32, "a rejected registration must not leak a definition");
    assert.equal(registry.find("custom-md").isEmpty(), true);
    assert.equal(registry.find("custom-mime").isEmpty(), true);
});

test("unregistering a language retires its id and extension mappings", () => {
    const registry = createDefaultLanguageRegistry();
    assert.equal(registry.unregister("json"), true);
    assert.equal(registry.find("json").isEmpty(), true);
    assert.equal(registry.findByExtension(".json").isEmpty(), true);
    assert.equal(registry.unregister("json"), false);
    assert.equal(registry.list().length, 31);

    const revived: LanguageDefinition = {
        id: "json", displayName: "JSON", extensions: [".json2"], mimeTypes: [], support: "text",
    };
    assert.throws(() => registry.register(revived), /already used/);
    assert.equal(registry.resolve("data.json").isEmpty(), true);
});

test("language resolution prefers the longest matching suffix and returns empty for unknown files", () => {
    const registry = createDefaultLanguageRegistry();

    const archive = registry.resolve("build/output.tar.gz");
    assert.equal(archive.isPresent(), true);
    assert.equal(archive.get().language.id, "compress");
    assert.equal(archive.get().extension, ".tar.gz");
    assert.equal(archive.get().confidence, "exact");

    const gzip = registry.resolve("output.gz");
    assert.equal(gzip.isPresent(), true);
    assert.equal(gzip.get().extension, ".gz");

    const markdown = registry.resolve("docs/README.MD");
    assert.equal(markdown.isPresent(), true);
    assert.equal(markdown.get().language.id, "markdown");
    assert.equal(markdown.get().extension, ".md");

    for (const path of ["file.unknown", "file", "dir/.", "dir/..", ""]) {
        assert.equal(registry.resolve(path).isEmpty(), true, path);
    }
});

const outlineNode = (id: string, overrides: Partial<ParsedOutlineNode> = {}): ParsedOutlineNode => ({
    id,
    kind: "heading",
    name: id,
    summary: "",
    range: { startLine: 0, endLine: 1, startByte: 0, endByte: 1 },
    ...overrides,
});

const languageRegistryWith = (nodes: readonly ParsedOutlineNode[]): LanguageRegistry => {
    const definition: LanguageDefinition = {
        id: "stub",
        displayName: "Stub",
        extensions: [".stub"],
        mimeTypes: [],
        support: "outline",
        parser: { language: "stub", parse: () => nodes },
    };
    return new LanguageRegistry({ definitions: [definition] });
};

test("language parse rejects duplicate ids, unknown parents, out-of-parent ranges and invalid ranges", () => {
    const source = "alpha\nbeta\ngamma\n";

    const parsed = languageRegistryWith([outlineNode("heading")]).parse("notes.stub", source);
    assert.equal(parsed.isPresent(), true);
    assert.deepEqual(parsed.get().nodes.map(node => node.id), ["heading"]);

    assert.throws(
        () => languageRegistryWith([outlineNode("dup"), outlineNode("dup")]).parse("notes.stub", source),
        /duplicate outline node id/,
    );
    assert.throws(
        () => languageRegistryWith([outlineNode("child", { parentId: "ghost" })]).parse("notes.stub", source),
        /unknown parent/,
    );
    assert.throws(
        () => languageRegistryWith([
            outlineNode("parent", { range: { startLine: 0, endLine: 2, startByte: 0, endByte: 10 } }),
            outlineNode("child", { parentId: "parent", range: { startLine: 0, endLine: 3, startByte: 0, endByte: 10 } }),
        ]).parse("notes.stub", source),
        /outside its parent/,
    );
    assert.throws(
        () => languageRegistryWith([outlineNode("bad", { range: { startLine: 1, endLine: 0, startByte: 0, endByte: 0 } })])
            .parse("notes.stub", source),
        /invalid outline node/,
    );
    assert.throws(
        () => languageRegistryWith([outlineNode("bad", { range: { startLine: 0, endLine: 99, startByte: 0, endByte: 5 } })])
            .parse("notes.stub", source),
        /invalid range for outline node bad/,
    );
});

// ---------------------------------------------------------------------------
// 9. agent surface
// ---------------------------------------------------------------------------

test("the surface declares three disjoint tiers with agent tools only", () => {
    const byTier = (tier: SurfaceTier): string[] =>
        SURFACE_MODULES.filter(entry => entry.tier === tier).map(entry => entry.module);
    const agentModules = byTier("agent");
    const hostModules = byTier("host");
    const hiddenModules = byTier("hidden");

    assert.deepEqual(hiddenModules, ["workflow", "policy", "profession", "behaviour"]);
    assert.deepEqual(hostModules,
        ["capability", "manifest", "provenance", "receipt", "verification", "retrieval", "model", "runtime"]);
    assert.equal(agentModules.length, 15);
    assert.equal(agentModules.length + hostModules.length + hiddenModules.length, SURFACE_MODULES.length);
    for (const module of agentModules) {
        assert.equal(hostModules.includes(module) || hiddenModules.includes(module), false, module);
    }

    const surface = createAgentSurface();
    assert.deepEqual(surface.modules, agentModules);
    assert.deepEqual(surface.hidden, hiddenModules);
    assert.equal(surface.prefix, SURFACE_PREFIX);
    assert.deepEqual([...new Set(surface.tools.map(tool => tool.module))].sort(), [...agentModules].sort());

    for (const entry of SURFACE_MODULES) {
        if (entry.tier === "agent") assert.ok(entry.exposed.length > 0, entry.module);
        else assert.equal(entry.exposed.length, 0, `${entry.module} must expose nothing`);
    }
    assert.equal(Object.isFrozen(surface), true);
});

test("hidden modules are never offered as tools", () => {
    const surface = createAgentSurface();
    for (const module of ["workflow", "policy", "profession", "behaviour"]) {
        assert.equal(surface.hidden.includes(module), true);
        assert.equal(surface.tools.some(tool => tool.module === module), false);
        const entry = findModule(module);
        assert.equal(entry.isPresent(), true);
        assert.equal(entry.get().tier, "hidden");
        assert.equal(entry.get().exposed.length, 0);
    }
    assert.equal(findTool(`${SURFACE_PREFIX}_workflow.transition`).isEmpty(), true);
    assert.equal(findTool(`${SURFACE_PREFIX}_policy.decide`).isEmpty(), true);
});

test("tool names follow the prefix format and are unique", () => {
    const surface = createAgentSurface();
    const names = surface.tools.map(tool => tool.name);
    assert.equal(new Set(names).size, names.length);
    for (const tool of surface.tools) {
        assert.match(tool.name, /^attention_manifest_protocol_[a-z0-9_]+\.[a-z0-9_]+$/);
        assert.equal(tool.name, `${SURFACE_PREFIX}_${tool.module}.${tool.verb}`);
        assert.equal(tool.description.length > 0, true, tool.name);
        assert.equal(tool.authority.length > 0, true, tool.name);
        assert.equal(Object.isFrozen(tool), true);
        assert.equal(Object.isFrozen(tool.authority), true);
    }
    assert.equal(Object.isFrozen(surface.tools), true);
});

test("createAgentSurface only rejects host and hidden modules", () => {
    assert.throws(() => createAgentSurface({ only: ["workflow"] }), /hidden, not agent accessible/);
    assert.throws(() => createAgentSurface({ only: ["policy"] }), /hidden, not agent accessible/);
    assert.throws(() => createAgentSurface({ only: ["profession"] }), /hidden, not agent accessible/);
    assert.throws(() => createAgentSurface({ only: ["behaviour"] }), /hidden, not agent accessible/);
    assert.throws(() => createAgentSurface({ only: ["manifest"] }), /host, not agent accessible/);
    assert.throws(() => createAgentSurface({ only: ["runtime"] }), /host, not agent accessible/);
    assert.throws(() => createAgentSurface({ only: ["ghost"] }), /unknown surface module/);

    const restricted = createAgentSurface({ only: ["workspace", "project"] });
    assert.deepEqual([...new Set(restricted.tools.map(tool => tool.module))].sort(), ["project", "workspace"]);
    assert.deepEqual(restricted.hidden, ["workflow", "policy", "profession", "behaviour"]);
    assert.deepEqual(createAgentSurface({ only: [] }).tools, []);
});

test("bindings must be complete and nonnegative", () => {
    const valid: AgentBinding = {
        tenantId: "tenant-a", principalId: "principal-1", sessionId: "session-1", policyVersion: "policy-1",
        cancellationEpoch: 0,
    };
    assert.doesNotThrow(() => assertBinding(valid));
    assert.throws(() => assertBinding({ ...valid, tenantId: "" }), /tenantId/);
    assert.throws(() => assertBinding({ ...valid, tenantId: "   " }), /tenantId/);
    assert.throws(() => assertBinding({ ...valid, tenantId: undefined as unknown as string }), /tenantId/);
    assert.throws(() => assertBinding({ ...valid, principalId: "" }), /principalId/);
    assert.throws(() => assertBinding({ ...valid, sessionId: "   " }), /sessionId/);
    assert.throws(() => assertBinding({ ...valid, policyVersion: "" }), /policyVersion/);
    assert.throws(() => assertBinding({ ...valid, cancellationEpoch: -1 }), /cancellationEpoch/);
    assert.throws(() => assertBinding({ ...valid, cancellationEpoch: 1.5 }), /cancellationEpoch/);
    assert.throws(() => assertBinding({ ...valid, cancellationEpoch: Number.NaN }), /cancellationEpoch/);
    assert.throws(() => assertBinding({} as AgentBinding), /tenantId/);
});

test("model parameters cannot smuggle host-bound context at any depth", () => {
    assert.doesNotThrow(() => assertModelParameters({ path: "src/a.ts", start: 1, tags: ["a", "b"] }));

    const reserved = [
        "tenantId", "principalId", "sessionId", "turnId", "attemptId", "operationId", "policyVersion",
        "cancellationEpoch", "owner", "lease", "fence", "authority",
    ];
    for (const key of reserved) {
        assert.throws(() => assertModelParameters({ [key]: "x" }), /bound by the host/, key);
    }
    assert.throws(() => assertModelParameters({ nested: { tenantId: "t" } }), /bound by the host/);
    assert.throws(() => assertModelParameters({ list: [{ deep: { fence: 1 } }] }), /bound by the host/);
    assert.throws(() => assertModelParameters({ list: [[{ lease: "l" }]] }), /bound by the host/);
    assert.throws(() => assertModelParameters(null as unknown as Record<string, unknown>), /must be an object/);
    assert.throws(() => assertModelParameters([] as unknown as Record<string, unknown>), /must be an object/);
    assert.throws(() => assertModelParameters("x" as unknown as Record<string, unknown>), /must be an object/);
});

test("describeSurface renders tools and lists every withheld module", () => {
    const text = describeSurface();
    assert.match(text, /^# Agent surface/m);
    assert.match(text, /## Withheld from the model/);
    assert.match(text, /attention_manifest_protocol_workspace\.write \(mutating\)/);
    for (const module of ["workflow", "policy", "profession", "behaviour"]) {
        assert.match(text, new RegExp(`- ${module} \\(hidden\\)`), module);
    }
    for (const module of ["capability", "manifest", "provenance", "receipt", "verification", "retrieval", "model", "runtime"]) {
        assert.match(text, new RegExp(`- ${module} \\(host\\)`), module);
    }

    const restricted = describeSurface(createAgentSurface({ only: ["workspace"] }));
    assert.doesNotMatch(restricted, /attention_manifest_protocol_project\.rules/);
    assert.match(restricted, /- workflow \(hidden\)/);
});

// ---------------------------------------------------------------------------
// 10. agent gateway
// ---------------------------------------------------------------------------

const hostBinding: AgentBinding = Object.freeze({
    tenantId: "tenant-a",
    principalId: "principal-1",
    sessionId: "session-1",
    policyVersion: "policy-1",
    cancellationEpoch: 0,
});
const readName = `${SURFACE_PREFIX}_workspace.read`;
const writeName = `${SURFACE_PREFIX}_workspace.write`;
const budgetName = `${SURFACE_PREFIX}_budget.remaining`;

interface GatewaySetupOptions {
    readonly handlers?: Readonly<Record<string, GatewayHandler>>;
    readonly authorize?: (authority: readonly string[], binding: AgentBinding) => boolean;
    readonly surface?: AgentSurface;
}

function createGateway(options: GatewaySetupOptions = {}): { gateway: AgentGateway; calls: GatewayCallRecord[] } {
    const calls: GatewayCallRecord[] = [];
    const handlers: Readonly<Record<string, GatewayHandler>> = options.handlers ?? {
        [readName]: (parameters, context) => ({
            name: context.tool.name,
            verb: context.tool.verb,
            mutating: context.tool.mutating,
            idempotencyKey: context.idempotencyKey,
            parameters,
        }),
        [writeName]: (parameters, context) => ({ written: parameters.expectedHash, idempotencyKey: context.idempotencyKey }),
        [budgetName]: () => 42,
    };
    const gateway = new AgentGateway({
        handlers,
        ...(options.authorize === undefined ? {} : { authorize: options.authorize }),
        ...(options.surface === undefined ? {} : { surface: options.surface }),
        onCall: record => { calls.push(record); },
    });
    return { gateway, calls };
}

test("gateway dispatch returns the handler result with the bound tool context and journals once", () => {
    const { gateway, calls } = createGateway();
    assert.equal(gateway.tools.length, createAgentSurface().tools.length);

    const result = gateway.call(readName, { path: "src/a.ts" }, { binding: hostBinding });
    assert.deepEqual(result, {
        name: readName,
        verb: "read",
        mutating: false,
        idempotencyKey: undefined,
        parameters: { path: "src/a.ts" },
    });
    assert.equal(calls.length, 1);
    const record = calls[0];
    assert.ok(record);
    assert.equal(record.tool, readName);
    assert.equal(record.mutating, false);
    assert.equal(record.ok, true);
    assert.equal(record.error, undefined);
    assert.equal(Number.isFinite(record.durationMs), true);
    assert.equal(Object.isFrozen(record), true);

    const written = gateway.call(writeName, { expectedHash: "h" }, { binding: hostBinding, idempotencyKey: "op-1" });
    assert.deepEqual(written, { written: "h", idempotencyKey: "op-1" });
    assert.equal(calls.length, 2);
    assert.equal(calls[1]?.mutating, true);
    assert.equal(calls[1]?.idempotencyKey, "op-1");
    assert.equal(calls[1]?.ok, true);
});

test("gateway maps rejected calls to stable error codes", () => {
    const { gateway, calls } = createGateway();
    assert.throws(() => gateway.call(`${SURFACE_PREFIX}_workflow.transition`, {}, { binding: hostBinding }),
        gatewayCode("unknown_tool"));

    const restricted = createGateway({ surface: createAgentSurface({ only: ["workspace"] }) }).gateway;
    assert.throws(() => restricted.call(budgetName, {}, { binding: hostBinding }), gatewayCode("not_exposed"));

    assert.throws(() => gateway.call(readName, { tenantId: "evil" }, { binding: hostBinding }),
        gatewayCode("invalid_parameters"));
    assert.throws(() => gateway.call(readName, { nested: { owner: "me" } }, { binding: hostBinding }),
        gatewayCode("invalid_parameters"));
    assert.throws(() => gateway.call(writeName, { expectedHash: "h" }, { binding: hostBinding }),
        gatewayCode("mutating_requires_idempotency_key"));
    assert.throws(() => gateway.call(writeName, { expectedHash: "h" }, { binding: hostBinding, idempotencyKey: "   " }),
        gatewayCode("mutating_requires_idempotency_key"));
    assert.throws(() => gateway.call(`${SURFACE_PREFIX}_project.rules`, {}, { binding: hostBinding }),
        gatewayCode("handler_missing"));
    assert.throws(() => createGateway({ authorize: () => false }).gateway.call(readName, {}, { binding: hostBinding }),
        gatewayCode("unauthorized"));

    const failing = createGateway({ handlers: { [readName]: () => { throw new Error("boom"); } } }).gateway;
    assert.throws(() => failing.call(readName, {}, { binding: hostBinding }), gatewayCode("handler_failed"));

    // Only the calls dispatched through this gateway instance share its journal;
    // the restricted, denying and failing gateways keep their own.
    assert.equal(calls.length, 6);
    assert.deepEqual(calls.map(record => record.error), [
        "unknown_tool", "invalid_parameters", "invalid_parameters", "mutating_requires_idempotency_key",
        "mutating_requires_idempotency_key", "handler_missing",
    ]);
});

test("the host authorization hook receives the tool authority and can deny the call", () => {
    const seen: string[][] = [];
    const allowed = createGateway({
        authorize: (authority) => { seen.push([...authority]); return true; },
    });
    assert.ok(allowed.gateway.call(readName, {}, { binding: hostBinding }));
    assert.deepEqual(seen, [["workspace:read"]]);
    assert.equal(allowed.calls.length, 1);
    assert.equal(allowed.calls[0]?.ok, true);
});

test("the gateway journals exactly one record per call, including failures", () => {
    const { gateway, calls } = createGateway();
    const attempts: readonly { readonly call: () => unknown; readonly code: GatewayError["code"] }[] = [
        { call: () => gateway.call(`${SURFACE_PREFIX}_unknown.tool`, {}, { binding: hostBinding }), code: "unknown_tool" },
        { call: () => gateway.call(readName, { authority: "root" }, { binding: hostBinding }), code: "invalid_parameters" },
        { call: () => gateway.call(writeName, {}, { binding: hostBinding }), code: "mutating_requires_idempotency_key" },
        { call: () => gateway.call(readName, {}, { binding: { ...hostBinding, cancellationEpoch: -1 } }), code: "binding_invalid" },
        { call: () => gateway.call(`${SURFACE_PREFIX}_project.rules`, {}, { binding: hostBinding }), code: "handler_missing" },
        { call: () => gateway.call(readName, {}, { binding: { ...hostBinding, sessionId: "" } }), code: "binding_invalid" },
    ];
    for (const [index, attempt] of attempts.entries()) {
        assert.throws(attempt.call, gatewayCode(attempt.code));
        assert.equal(calls.length, index + 1, `one record for attempt ${index}`);
        const record = calls[index];
        assert.ok(record);
        assert.equal(record.ok, false);
        assert.equal(record.error, attempt.code);
        assert.equal(Number.isFinite(record.durationMs), true);
        assert.equal(Object.isFrozen(record), true);
    }
    assert.equal(new Set(calls).size, calls.length, "every journal record is a distinct object");

    // A successful call after failures still journals exactly one more entry.
    assert.ok(gateway.call(readName, {}, { binding: hostBinding }));
    assert.equal(calls.length, attempts.length + 1);
    assert.equal(calls.at(-1)?.ok, true);
});
