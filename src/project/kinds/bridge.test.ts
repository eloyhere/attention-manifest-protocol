import assert from "node:assert/strict";
import test from "node:test";
import { applyProjectKind, createProjectFromKind } from "./bridge.ts";
import { definition as goKind } from "./go.ts";
import { Project } from "../core.ts";
import { WorkspaceError } from "../../workspace/types.ts";

const scope = { tenantId: "t", rootId: "r" } as const;
const clock = () => "2026-01-01T00:00:00Z";

test("createProjectFromKind seeds the environment from the kind definition", () => {
    const project = createProjectFromKind(goKind, { ...scope, clock });
    assert.equal(project.kind, "go");
    assert.equal(project.environmentVersion, 0);
    assert.deepEqual(project.environment.variables, goKind.environment.variables);
    assert.deepEqual(project.environment.paths, goKind.environment.paths);
    assert.deepEqual(project.environment.dependencies, goKind.environment.dependencies);
});

test("the project owns its copy: changing the kind definition later has no effect", () => {
    const project = createProjectFromKind(goKind, { ...scope, clock });
    assert.equal(Object.isFrozen(project.environment), true);
    project.configureEnvironment({ variables: { GOFLAGS: "-mod=mod" } });
    assert.equal(project.environment.variables.GOFLAGS, "-mod=mod");
    assert.equal(goKind.environment.variables.GOFLAGS, "-mod=readonly");
    assert.equal(project.environmentVersion, 1);
});

test("kind notes flow into the environment brief as guidance", () => {
    const project = createProjectFromKind(goKind, { ...scope, clock, guidance: ["Prefer the module cache."] });
    const plan = project.environmentPlan();
    assert.equal(plan.kind, "go");
    if (goKind.notes !== undefined) assert.equal(plan.guidance.includes(goKind.notes), true);
    assert.equal(plan.guidance.includes("Prefer the module cache."), true);
});

test("applyProjectKind merges defaults while keeping project overrides", () => {
    const project = new Project({ ...scope, clock });
    project.configureEnvironment({ variables: { TEXINPUTS: "./styles//" }, paths: ["chapters"], dependencies: [{ id: "latexmk", scope: "build", version: ">=4" }] });
    const applied = applyProjectKind(project, goKind, { expectedVersion: 1 });
    assert.equal(project.kind, undefined);
    assert.deepEqual(applied.paths, ["cmd", "internal", "pkg", "bin", "chapters"]);
    assert.equal(applied.variables.TEXINPUTS, "./styles//");
    assert.equal(applied.variables.GO111MODULE, "on");
    assert.equal(applied.dependencies.some(dependency => dependency.id === "latexmk" && dependency.version === ">=4"), true);
    assert.equal(applied.dependencies.some(dependency => dependency.id === "go"), true);
    assert.equal(project.environmentVersion, 2);
    assert.throws(() => applyProjectKind(project, goKind, { expectedVersion: 1 }), (error: unknown) => error instanceof WorkspaceError && error.code === "version_conflict");
});

test("a kind default can be explicitly unset by the project", () => {
    const project = createProjectFromKind(goKind, { ...scope, clock });
    project.configureEnvironment({ variables: { GOFLAGS: "" } });
    const applied = applyProjectKind(project, goKind);
    assert.equal(applied.variables.GOFLAGS, "");
    const gaps = project.environmentPlan().gaps.filter(gap => gap.kind === "variable").map(gap => gap.id);
    assert.deepEqual(gaps, ["GOFLAGS"]);
});
