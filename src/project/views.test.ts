import assert from "node:assert/strict";
import test from "node:test";
import { WorkspaceError } from "../workspace/types.ts";
import { Project, validateView } from "./core.ts";
import type { ProjectView, ViewKind, ViewPurpose } from "./types.ts";

const scope = { tenantId: "tenant-a", rootId: "root-1" } as const;

const makeProject = (options: Record<string, unknown> = {}): Project =>
    new Project({ ...scope, clock: () => "2026-01-01T00:00:00.000Z", ...options });

const viewInput = (kind: ViewKind, overrides: Record<string, unknown> = {}) => ({
    kind,
    ...scope,
    projection: { kind },
    sourceRuleIds: [] as string[],
    ...overrides,
});

const invalidProject = (error: unknown): boolean => error instanceof WorkspaceError && error.code === "invalid_project";

test("view purpose, anchors, constraints and freshness are optional contract fields", () => {
    const project = makeProject();
    const view = project.putView(viewInput("er", {
        purpose: "routing",
        anchors: ["object:file:src/a.ts", "object:rule:rule-1"],
        constraints: ["anchors must resolve", "edges must be acyclic"],
        freshness: 0.75,
    }));

    assert.equal(view.purpose, "routing");
    assert.deepEqual(view.anchors, ["object:file:src/a.ts", "object:rule:rule-1"]);
    assert.deepEqual(view.constraints, ["anchors must resolve", "edges must be acyclic"]);
    assert.equal(view.freshness, 0.75);
    assert.equal(project.getView("er")?.purpose, "routing");
});

test("omitting the new view fields preserves the existing contract", () => {
    const project = makeProject();
    const view = project.putView(viewInput("flow"));

    assert.equal(view.purpose, undefined);
    assert.equal(view.anchors, undefined);
    assert.equal(view.constraints, undefined);
    assert.equal(view.freshness, undefined);
    assert.equal(view.version, 1);
    assert.equal(view.stale, false);
});

test("putView rejects an unknown purpose and out-of-range freshness", () => {
    const project = makeProject();
    const purposes: readonly string[] = ["route", "Routing", "", "diagnosis "];
    for (const purpose of purposes) {
        assert.throws(() => project.putView(viewInput("sequence", { purpose })), invalidProject, purpose);
    }
    for (const purpose of ["routing", "verification", "planning", "diagnosis", "retention"] as readonly ViewPurpose[]) {
        assert.doesNotThrow(() => project.putView(viewInput("sequence", { purpose })));
    }

    for (const freshness of [-0.01, 1.01, Number.NaN, Number.POSITIVE_INFINITY]) {
        assert.throws(() => project.putView(viewInput("venn", { freshness })), invalidProject, String(freshness));
    }
    for (const freshness of [0, 0.5, 1]) {
        assert.doesNotThrow(() => project.putView(viewInput("venn", { freshness })));
    }
});

test("putView rejects malformed anchors and constraints", () => {
    const project = makeProject();
    const malformed: readonly Record<string, unknown>[] = [
        { anchors: "object:file" },
        { anchors: ["valid", ""] },
        { anchors: ["valid", 42] },
        { constraints: "no cycles" },
        { constraints: ["valid", "  "] },
    ];
    for (const overrides of malformed) {
        assert.throws(() => project.putView(viewInput("architecture", overrides)), invalidProject);
    }
    assert.equal(project.listViews().length, 0, "a rejected view must not be stored");
});

test("validateView accepts a complete view and the freshness boundaries 0 and 1", () => {
    const project = makeProject();
    const view = project.putView(viewInput("er", {
        purpose: "verification",
        anchors: ["object:file:src/a.ts"],
        constraints: ["anchors must resolve"],
        freshness: 0,
    }));
    assert.doesNotThrow(() => validateView(view));
    assert.doesNotThrow(() => project.validateView(view));
    assert.doesNotThrow(() => validateView({ ...view, freshness: 1 }));
    assert.doesNotThrow(() => validateView({ ...view, freshness: 0.5 }));
});

test("validateView rejects freshness outside 0..1 and non-finite values", () => {
    const project = makeProject();
    const view = project.putView(viewInput("flow", { freshness: 0.5 }));
    for (const freshness of [-0.01, 1.01, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
        assert.throws(() => validateView({ ...view, freshness }), invalidProject, String(freshness));
    }
    assert.throws(() => validateView({ ...view, freshness: "0.5" as unknown as number }), invalidProject);
});

test("validateView rejects anchors that do not exist", () => {
    const project = makeProject();
    const view = project.putView(viewInput("architecture", {
        anchors: ["object:file:src/a.ts", "object:rule:rule-1"],
    }));

    assert.throws(
        () => validateView(view, { knownAnchors: ["object:file:src/a.ts"] }),
        invalidProject,
    );
    assert.doesNotThrow(() => validateView(view, {
        knownAnchors: ["object:file:src/a.ts", "object:rule:rule-1"],
    }));
    assert.throws(
        () => validateView(view, { anchorExists: anchor => anchor === "object:file:src/a.ts" }),
        invalidProject,
    );
    assert.doesNotThrow(() => validateView(view, { anchorExists: () => true }));
});

test("Project.validateView and putView use the configured host anchor resolver", () => {
    const project = makeProject({ anchorExists: (anchor: string) => anchor === "object:file:src/a.ts" });
    assert.throws(
        () => project.putView(viewInput("venn", { anchors: ["object:file:src/missing.ts"] })),
        invalidProject,
    );
    assert.equal(project.listViews().length, 0);

    const view = project.putView(viewInput("venn", { anchors: ["object:file:src/a.ts"] }));
    assert.doesNotThrow(() => project.validateView(view));
    assert.throws(
        () => project.validateView({ ...view, anchors: ["object:file:src/missing.ts"] }),
        invalidProject,
    );
});

test("validateView rejects malformed identity, version, source and contract fields", () => {
    const project = makeProject();
    const base = project.putView(viewInput("sequence"));
    const malformed: readonly Record<string, unknown>[] = [
        { kind: "unknown" },
        { tenantId: "" },
        { rootId: "   " },
        { version: 0 },
        { version: 1.5 },
        { stale: "no" },
        { updatedAt: "" },
        { sourceRuleIds: "rule-1" },
        { sourceRuleIds: ["rule-1", ""] },
        { sourceVersions: "rule-1" },
        { sourceVersions: [{ ruleId: "", version: 1 }] },
        { sourceVersions: [{ ruleId: "rule-1", version: 0 }] },
        { purpose: "Routing" },
        { anchors: ["valid", 42] },
        { constraints: [""] },
    ];
    for (const overrides of malformed) {
        assert.throws(() => validateView({ ...base, ...overrides } as ProjectView), invalidProject, JSON.stringify(overrides));
    }

    const withoutProjection: Record<string, unknown> = { ...base };
    delete withoutProjection.projection;
    assert.throws(() => validateView(withoutProjection as unknown as ProjectView), invalidProject);
});

test("validateView accepts legacy views that omit every optional contract field", () => {
    const project = makeProject();
    const view = project.putView(viewInput("mindmap"));
    assert.doesNotThrow(() => validateView(view));
    assert.equal(view.purpose, undefined);
    assert.equal(view.anchors, undefined);
    assert.equal(view.constraints, undefined);
    assert.equal(view.freshness, undefined);
});
