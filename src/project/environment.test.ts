import assert from "node:assert/strict";
import test from "node:test";
import { Project } from "./core.ts";
import { emptyEnvironment, mergeEnvironment, planEnvironment } from "./environment.ts";
import { WorkspaceError } from "../workspace/types.ts";

const scope = { tenantId: "t", rootId: "r" } as const;
const project = (options: Record<string, unknown> = {}): Project => new Project({ ...scope, clock: () => "2026-01-01T00:00:00Z", ...options });

function code(expected: WorkspaceError["code"]) {
    return (error: unknown): boolean => error instanceof WorkspaceError && error.code === expected;
}

test("a project stores its own environment and starts empty at version zero", () => {
    const empty = project();
    assert.deepEqual(empty.environment, emptyEnvironment());
    assert.equal(empty.environmentVersion, 0);
    assert.equal(empty.kind, undefined);
    assert.equal(Object.isFrozen(empty.environment), true);

    const seeded = project({
        kind: "go",
        environment: { variables: { GO111MODULE: "on" }, paths: ["src"], dependencies: [{ id: "go", scope: "build" }] },
    });
    assert.equal(seeded.kind, "go");
    assert.equal(seeded.environment.variables.GO111MODULE, "on");
    assert.deepEqual(seeded.environment.paths, ["src"]);
    assert.equal(seeded.environment.dependencies[0]?.id, "go");
    assert.equal(seeded.environmentVersion, 0);
});

test("configureEnvironment merges and versions, keeping the previous value immutable", () => {
    const value = project();
    const before = value.environment;
    const next = value.configureEnvironment({ variables: { A: "1", B: "" }, paths: ["src", "src", "test"] });
    assert.equal(value.environmentVersion, 1);
    assert.deepEqual(next.variables, { A: "1", B: "" });
    assert.deepEqual(next.paths, ["src", "test"]);
    assert.equal(Object.isFrozen(next), true);
    assert.deepEqual(before, emptyEnvironment());

    const merged = value.configureEnvironment({ variables: { A: "2", C: "3" } });
    assert.deepEqual(merged.variables, { A: "2", B: "", C: "3" });
    assert.equal(value.environmentVersion, 2);

    value.configureEnvironment({ dependencies: [{ id: "go", scope: "build" }] });
    value.configureEnvironment({ dependencies: [{ id: "go", scope: "build", version: ">=1.22" }] });
    assert.equal(value.environment.dependencies.length, 1);
    assert.equal(value.environment.dependencies[0]?.version, ">=1.22");
});

test("setEnvironment replaces instead of merging", () => {
    const value = project({ environment: { variables: { A: "1" }, paths: ["src"], dependencies: [] } });
    const replaced = value.setEnvironment({ variables: { B: "2" }, paths: [], dependencies: [] });
    assert.deepEqual(replaced.variables, { B: "2" });
    assert.deepEqual(value.environment.paths, []);
    assert.equal(value.environmentVersion, 1);
});

test("environment writes honour expectedVersion and validation", () => {
    const value = project();
    value.configureEnvironment({ variables: { A: "1" } }, { expectedVersion: 0 });
    assert.throws(() => value.configureEnvironment({ variables: { A: "2" } }, { expectedVersion: 0 }), code("version_conflict"));
    assert.throws(() => value.setEnvironment(emptyEnvironment(), { expectedVersion: 0 }), code("version_conflict"));
    assert.throws(() => value.configureEnvironment({ variables: { bad_name: "x" } }), code("invalid_project"));
    assert.throws(() => value.configureEnvironment({ paths: ["../escape"] }), code("invalid_project"));
    assert.throws(() => value.configureEnvironment({ dependencies: [{ id: "", scope: "build" } as never] }), code("invalid_project"));
    assert.equal(value.environmentVersion, 1);
});

test("environmentPlan lists unset variables, missing paths and unpinned dependencies", () => {
    const value = project({
        kind: "go",
        guidance: ["Run go mod tidy before building."],
        environment: {
            variables: { GO111MODULE: "on", GOPROXY: "" },
            paths: ["src", "bin"],
            dependencies: [{ id: "go", scope: "build", manager: "go" }, { id: "lint", scope: "tool", optional: true }],
        },
    });
    value.putMetadata({ ...scope, path: "src", tags: [], ruleIds: [] });
    const plan = value.environmentPlan();
    assert.equal(plan.kind, "go");
    assert.equal(plan.version, 0);
    assert.deepEqual(plan.gaps.map(gap => `${gap.kind}:${gap.id}`), ["variable:GOPROXY", "path:bin", "dependency:go@build"]);
    assert.equal(plan.ready, false);
    assert.equal(plan.guidance[0], "Run go mod tidy before building.");
    assert.equal(plan.guidance.length, 4);
    assert.equal(plan.guidance.some(line => line.includes("GOPROXY")), true);
    assert.equal(plan.guidance.some(line => line.includes("bin")), true);
    assert.equal(plan.guidance.some(line => line.includes("Pin go")), true);
    assert.equal(Object.isFrozen(plan.gaps), true);
    assert.equal(Object.isFrozen(plan.guidance), true);

    value.configureEnvironment({ variables: { GOPROXY: "https://proxy.example" }, dependencies: [{ id: "go", scope: "build", version: ">=1.22" }] });
    value.putMetadata({ ...scope, path: "bin", tags: [], ruleIds: [] });
    const ready = value.environmentPlan();
    assert.deepEqual(ready.gaps, []);
    assert.equal(ready.ready, true);
    assert.equal(ready.version, 1);
});

test("describeEnvironment renders a deterministic configuration brief", () => {
    const value = project({
        kind: "tex",
        environment: { variables: { TEXINPUTS: "" }, paths: ["figures"], dependencies: [{ id: "latexmk", scope: "build", version: ">=4", manager: "tlmgr" }] },
    });
    const brief = value.describeEnvironment();
    assert.equal(brief, value.describeEnvironment());
    assert.match(brief, /^# Project environment/m);
    assert.match(brief, /^kind: tex$/m);
    assert.match(brief, /^version: 0$/m);
    assert.match(brief, /^ready: no \(2 gaps\)$/m);
    assert.match(brief, /- TEXINPUTS = \(unset\)/);
    assert.match(brief, /- figures/);
    assert.match(brief, /- latexmk >=4 \(build, manager: tlmgr\)/);
    assert.match(brief, /1\. Set environment variable TEXINPUTS/);
    assert.match(brief, /2\. Create or register the path figures/);
});

test("mergeEnvironment and planEnvironment stay pure helpers", () => {
    const base = { variables: { A: "1" }, paths: ["a"], dependencies: [{ id: "x", scope: "build" as const }] };
    const merged = mergeEnvironment(base, { variables: { A: "2", B: "3" }, paths: ["a", "b"] });
    assert.deepEqual(merged.variables, { A: "2", B: "3" });
    assert.deepEqual(merged.paths, ["a", "b"]);
    assert.deepEqual(base.variables, { A: "1" });
    const plan = planEnvironment(merged, { kind: "text", version: 7, presentPaths: ["a"] });
    assert.equal(plan.kind, "text");
    assert.equal(plan.version, 7);
    assert.deepEqual(plan.gaps.map(gap => gap.id), ["b", "x@build"]);
    assert.equal(plan.ready, false);
});

test("the stored environment cannot be mutated through its snapshot", () => {
    const value = project({ environment: { variables: { A: "1" }, paths: ["src"], dependencies: [{ id: "go", scope: "build" }] } });
    const snapshot = value.environment;
    assert.throws(() => { (snapshot.paths as string[]).push("evil"); }, TypeError);
    assert.throws(() => { (snapshot.variables as Record<string, string>).A = "2"; }, TypeError);
    assert.deepEqual(value.environment.paths, ["src"]);
    assert.equal(value.environment.variables.A, "1");
});
