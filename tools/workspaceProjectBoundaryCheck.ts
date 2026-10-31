#!/usr/bin/env node
/**
 * Boundary checks for `amp_tool_workspace_project`, `amp_tool_workspace_outline`
 * and `amp_tool_workspace_dependency`.
 *
 * Happy-path behaviour is covered by `workspaceProjectCheck.ts`; this file only
 * probes the edges of the declared schemas and the service's own limits: enum
 * and project-id validation, ambiguous scope, mixed toolchains, Gradle wrapper
 * selection, hostile runner outcomes, outline depth/count/filter boundaries and
 * dependency self-edges, cycles, duplicate declarations and pagination.
 *
 * Every fixture is scanned through `scanStructuredWorkspace`, so the assertions
 * run over the same snapshot adapter a host uses instead of hand-built entities.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { MemoryContentStore } from "../src/context/contentStore.ts";
import type { WorkspaceEntity, WorkspaceSnapshot } from "../src/context/workspace.ts";
import { WorkspaceAgentService } from "../src/context/workspaceService.ts";
import type { WorkspaceRunOutcome, WorkspaceRunRequest, WorkspaceRunner, WorkspaceServiceLimits } from "../src/context/workspaceService.ts";
import { ToolIds } from "../src/naming/index.ts";
import type {
    WorkspaceDependencyEdge,
    WorkspaceOutlineNode,
    WorkspaceProjectAction,
    WorkspaceProjectBrand,
    WorkspaceProjectDependency,
    WorkspaceProjectSummary,
    WorkspaceResponse,
} from "../src/protocol/workspace.ts";
import { scanStructuredWorkspace } from "./support/documentScanner.ts";
import type { StructuredWorkspaceFile } from "./support/documentScanner.ts";

interface ServiceOptions {
    runner?: WorkspaceRunner;
    limits?: Partial<WorkspaceServiceLimits>;
}

interface Fixture {
    snapshot: WorkspaceSnapshot;
    service: (options?: ServiceOptions) => WorkspaceAgentService;
    call: (host: WorkspaceAgentService, tool: string, args?: Record<string, unknown>) => WorkspaceResponse;
}

interface RecordedRunner {
    runner: WorkspaceRunner;
    requests: WorkspaceRunRequest[];
}

const ExecutionActions: readonly Exclude<WorkspaceProjectAction, "detect">[] = ["build", "compile", "run", "test"];

/**
 * Build one immutable snapshot plus constructors bound to its revision. A test
 * creates as many services as it needs (to vary the runner or one limit) over
 * the same snapshot.
 */
const fixtureOf: (files: readonly StructuredWorkspaceFile[], projectIds: readonly string[]) => Fixture = (
    files: readonly StructuredWorkspaceFile[],
    projectIds: readonly string[],
): Fixture => {
    const store: MemoryContentStore = new MemoryContentStore();
    const snapshot: WorkspaceSnapshot = scanStructuredWorkspace(files, store);
    const service: (options?: ServiceOptions) => WorkspaceAgentService = (options: ServiceOptions = {}): WorkspaceAgentService =>
        new WorkspaceAgentService({
            agentId: "a.boundary",
            projectIds,
            snapshot,
            store,
            ...(options.runner === (void 0) ? {} : { runner: options.runner }),
            ...(options.limits === (void 0) ? {} : { limits: options.limits }),
        });
    const call: (host: WorkspaceAgentService, tool: string, args?: Record<string, unknown>) => WorkspaceResponse = (
        host: WorkspaceAgentService,
        tool: string,
        args: Record<string, unknown> = {},
    ): WorkspaceResponse => host.call(tool, { revision: snapshot.revision, ...args });
    return { snapshot, service, call };
};

/** Build a manifest body without repeating JSON escaping in every fixture. */
const manifestOf: (value: Record<string, unknown>) => string = (value: Record<string, unknown>): string => JSON.stringify(value);

const data: (response: WorkspaceResponse) => Record<string, unknown> = (response: WorkspaceResponse): Record<string, unknown> => {
    assert.equal(response.ok, true, JSON.stringify(response));
    if (!response.ok) {
        throw new Error("expected success");
    }
    return response.data;
};

const code: (response: WorkspaceResponse) => string = (response: WorkspaceResponse): string => {
    assert.equal(response.ok, false, JSON.stringify(response));
    if (!("error" in response)) {
        throw new Error("expected error");
    }
    return response.error.code;
};

const summaryOf: (result: Record<string, unknown>, projectId: string) => WorkspaceProjectSummary = (
    result: Record<string, unknown>,
    projectId: string,
): WorkspaceProjectSummary =>
    (result.projects as WorkspaceProjectSummary[]).find((project: WorkspaceProjectSummary): boolean => project.projectId === projectId)!;

const brandOf: (project: WorkspaceProjectSummary, brand: string) => WorkspaceProjectBrand = (
    project: WorkspaceProjectSummary,
    brand: string,
): WorkspaceProjectBrand => project.detected.find((item: WorkspaceProjectBrand): boolean => item.brand === brand)!;

const flattenOutline: (nodes: readonly WorkspaceOutlineNode[]) => WorkspaceOutlineNode[] = (
    nodes: readonly WorkspaceOutlineNode[],
): WorkspaceOutlineNode[] =>
    nodes.flatMap((node: WorkspaceOutlineNode): WorkspaceOutlineNode[] => [node, ...flattenOutline(node.children)]);

const dependencyRows: (result: Record<string, unknown>) => WorkspaceProjectDependency[] = (
    result: Record<string, unknown>,
): WorkspaceProjectDependency[] => result.projects as WorkspaceProjectDependency[];

const edgeIds: (edges: readonly WorkspaceDependencyEdge[]) => string[] = (edges: readonly WorkspaceDependencyEdge[]): string[] =>
    edges.map((edge: WorkspaceDependencyEdge): string => edge.id);

const recordingRunner: (outcome?: WorkspaceRunOutcome) => RecordedRunner = (
    outcome: WorkspaceRunOutcome = { ok: true, exitCode: 0, stdout: "", stderr: "", durationMs: 1 },
): RecordedRunner => {
    const requests: WorkspaceRunRequest[] = [];
    return {
        requests,
        runner: {
            run: (request: WorkspaceRunRequest): WorkspaceRunOutcome => {
                requests.push({ ...request });
                return outcome;
            },
        },
    };
};

/** Hostile port: returns whatever a buggy host might return, bypassing the type. */
const hostileRunner: (outcome: unknown) => WorkspaceRunner = (outcome: unknown): WorkspaceRunner => ({
    run: (_request: WorkspaceRunRequest): WorkspaceRunOutcome => outcome as WorkspaceRunOutcome,
});

const throwingRunner: WorkspaceRunner = {
    run: (_request: WorkspaceRunRequest): WorkspaceRunOutcome => {
        throw new Error("runner exploded");
    },
};

/** Root project that is both a pnpm workspace and a CMake tree. */
const mixedFixture: Fixture = fixtureOf(
    [
        { path: "package.json", content: manifestOf({ name: "mix" }) },
        { path: "pnpm-lock.yaml", content: "lockfileVersion: 9\n" },
        { path: "cmake/CMakeLists.txt", content: "project(mix)\n" },
    ],
    ["project:."],
);

/** Two Gradle projects: one ships the wrapper, one only has the build script. */
const gradleFixture: Fixture = fixtureOf(
    [
        { path: "packages/wrap/package.json", content: manifestOf({ name: "wrap" }) },
        { path: "packages/wrap/build.gradle", content: "plugins {}\n" },
        { path: "packages/wrap/gradlew", content: "#!/bin/sh\n" },
        { path: "packages/plain/package.json", content: manifestOf({ name: "plain" }) },
        { path: "packages/plain/build.gradle", content: "plugins {}\n" },
    ],
    ["project:packages/wrap", "project:packages/plain"],
);

/** Project scope with an authorized symbol and one project the host did not grant. */
const scopeFixture: Fixture = fixtureOf(
    [
        { path: "package.json", content: manifestOf({ name: "root" }) },
        { path: "packages/app/package.json", content: manifestOf({ name: "app" }) },
        { path: "packages/secret/package.json", content: manifestOf({ name: "secret" }) },
        { path: "src/lib.ts", content: "export function go(): number {\n    return 1;\n}\n" },
    ],
    ["project:.", "project:packages/app"],
);

/** A lone README with no package.json: the scanner synthesizes the root project. */
const emptyFixture: Fixture = fixtureOf([{ path: "README.md", content: "" }], ["project:."]);

/** One pnpm project used for execution and runner-port checks. */
const singleFixture: Fixture = fixtureOf(
    [
        { path: "package.json", content: manifestOf({ name: "single" }) },
        { path: "pnpm-lock.yaml", content: "lockfileVersion: 9\n" },
    ],
    ["project:."],
);

/**
 * Project → docs/ and src/ directories → two files → symbols/knowledge, plus an
 * extensionless file and an external package entity. Markdown headings are
 * top-level siblings, so their startLine order is observable.
 */
const outlineFixture: Fixture = fixtureOf(
    [
        { path: "package.json", content: manifestOf({ name: "outline-boundary", dependencies: { lodash: "^4.17.21" } }) },
        {
            path: "src/lib.ts",
            content: "export function alpha(): number {\n    return 1;\n}\nexport function beta(): number {\n    return 2;\n}\n",
        },
        { path: "docs/guide.md", content: "# Alpha\nintro\n# Beta\nmore\n" },
        { path: "LICENSE", content: "MIT\n" },
    ],
    ["project:."],
);

const lonelyFixture: Fixture = fixtureOf([{ path: "package.json", content: manifestOf({ name: "lonely" }) }], ["project:."]);

/** The manifest declares a workspace dependency on its own package name. */
const selfFixture: Fixture = fixtureOf(
    [{ path: "package.json", content: manifestOf({ name: "self", dependencies: { self: "workspace:*" } }) }],
    ["project:."],
);

/** root → app and app → root: a manifest-level project cycle. */
const cycleFixture: Fixture = fixtureOf(
    [
        { path: "package.json", content: manifestOf({ name: "root", dependencies: { app: "workspace:*" } }) },
        { path: "packages/app/package.json", content: manifestOf({ name: "app", dependencies: { root: "workspace:*" } }) },
    ],
    ["project:.", "project:packages/app"],
);

/** The same local target declared twice, from two dependency sections. */
const duplicateFixture: Fixture = fixtureOf(
    [
        {
            path: "package.json",
            content: manifestOf({ name: "root", dependencies: { app: "workspace:*" }, devDependencies: { app: "workspace:*" } }),
        },
        { path: "packages/app/package.json", content: manifestOf({ name: "app" }) },
    ],
    ["project:.", "project:packages/app"],
);

/** root → app → lib chain plus one external package, over three in-scope projects. */
const dependencyFixture: Fixture = fixtureOf(
    [
        {
            path: "package.json",
            content: manifestOf({ name: "root", dependencies: { app: "workspace:*", lodash: "^4.17.21" } }),
        },
        { path: "packages/app/package.json", content: manifestOf({ name: "app", dependencies: { lib: "workspace:*" } }) },
        { path: "packages/lib/package.json", content: manifestOf({ name: "lib" }) },
    ],
    ["project:.", "project:packages/app", "project:packages/lib"],
);

test("project accepts every action enum member and ignores brand and dryRun for detect", (): void => {
    const recorder: RecordedRunner = recordingRunner();
    const host: WorkspaceAgentService = mixedFixture.service({ runner: recorder.runner });
    const projectId: string = "project:.";
    const commands: Record<string, string> = {
        build: "pnpm run build",
        compile: "pnpm run compile",
        run: "pnpm start",
        test: "pnpm test",
    };
    ExecutionActions.forEach((action: Exclude<WorkspaceProjectAction, "detect">): void => {
        const result: Record<string, unknown> = data(mixedFixture.call(host, ToolIds.workspaceProject, { projectId, action, dryRun: true }));
        assert.equal(result.action, action);
        assert.equal(result.brand, "pnpm");
        assert.equal(result.command, commands[action]);
        assert.equal(result.cwd, ".");
        assert.equal(result.dryRun, true);
    });
    assert.equal(recorder.requests.length, 0);
    const detected: Record<string, unknown> = data(
        mixedFixture.call(host, ToolIds.workspaceProject, { projectId, action: "detect", brand: "cmake", dryRun: true }),
    );
    assert.equal(detected.action, "detect");
    assert.equal(detected.total, 1);
    assert.equal(Object.hasOwn(detected, "command"), false);
    assert.equal(Object.hasOwn(detected, "brand"), false);
    assert.equal(Object.hasOwn(detected, "dryRun"), false);
    assert.equal(summaryOf(detected, projectId).brand, "pnpm");
    assert.equal(recorder.requests.length, 0);
});

test("project rejects unknown actions, wrong action types and unusable brands", (): void => {
    const host: WorkspaceAgentService = mixedFixture.service();
    const projectId: string = "project:.";
    const call: (args: Record<string, unknown>) => WorkspaceResponse = (args: Record<string, unknown>): WorkspaceResponse =>
        mixedFixture.call(host, ToolIds.workspaceProject, { projectId, ...args });
    assert.equal(code(call({ action: "deploy" })), "invalid_arguments");
    assert.equal(code(call({ action: 5 })), "invalid_arguments");
    assert.equal(code(call({ action: "build", brand: "unknown" })), "invalid_arguments");
    assert.equal(code(call({ action: "build", brand: "" })), "invalid_arguments");
    assert.equal(code(call({ action: "build", brand: "b".repeat(33) })), "invalid_arguments");
    assert.equal(code(call({ action: "detect", unexpected: true })), "invalid_arguments");
});

test("project maps unknown ids to not_available and non-project ids to invalid_arguments", (): void => {
    const host: WorkspaceAgentService = scopeFixture.service();
    const call: (args: Record<string, unknown>) => WorkspaceResponse = (args: Record<string, unknown>): WorkspaceResponse =>
        scopeFixture.call(host, ToolIds.workspaceProject, args);
    assert.equal(code(call({ projectId: "project:missing" })), "not_available");
    assert.equal(code(call({ projectId: "file:package.json" })), "invalid_arguments");
    const symbol: WorkspaceEntity | undefined = scopeFixture.snapshot.entities.find(
        (entity: WorkspaceEntity): boolean => entity.kind === "symbol",
    );
    assert.ok(symbol);
    assert.equal(symbol!.id.startsWith("symbol:"), true);
    assert.equal(code(call({ projectId: symbol!.id })), "invalid_arguments");
    assert.equal(code(call({ projectId: "project:packages/secret" })), "not_available");
});

test("project requires exactly one scoped project for execution", (): void => {
    const recorder: RecordedRunner = recordingRunner();
    const ambiguous: WorkspaceAgentService = scopeFixture.service({ runner: recorder.runner });
    assert.equal(code(scopeFixture.call(ambiguous, ToolIds.workspaceProject, { action: "build" })), "invalid_arguments");
    assert.equal(recorder.requests.length, 0);
    const single: WorkspaceAgentService = singleFixture.service({ runner: recorder.runner });
    const result: Record<string, unknown> = data(singleFixture.call(single, ToolIds.workspaceProject, { action: "build" }));
    assert.equal(result.projectId, "project:.");
    assert.equal(result.brand, "pnpm");
    assert.equal(result.exitCode, 0);
    assert.equal(recorder.requests.length, 1);
});

test("project mixed toolchains fall back to the first brand that defines the action", (): void => {
    const recorder: RecordedRunner = recordingRunner({ ok: true, exitCode: 0, stdout: "", stderr: "" });
    const host: WorkspaceAgentService = mixedFixture.service({ runner: recorder.runner });
    const projectId: string = "project:.";
    const detected: Record<string, unknown> = data(mixedFixture.call(host, ToolIds.workspaceProject, { projectId, action: "detect" }));
    const summary: WorkspaceProjectSummary = summaryOf(detected, projectId);
    assert.equal(summary.brand, "pnpm");
    assert.deepEqual(summary.actions, ["build", "compile", "run", "test"]);
    assert.deepEqual(summary.detected.map((item: WorkspaceProjectBrand): string => item.brand), ["pnpm", "npm", "cmake"]);
    summary.detected.forEach((brand: WorkspaceProjectBrand): void => {
        assert.deepEqual(Object.keys(brand.commands).sort(), [...brand.actions].sort());
    });
    const result: Record<string, unknown> = data(mixedFixture.call(host, ToolIds.workspaceProject, { projectId, action: "run" }));
    assert.equal(result.brand, "pnpm");
    assert.equal(result.command, "pnpm start");
    assert.equal(result.cwd, ".");
    assert.equal(recorder.requests.length, 1);
    assert.deepEqual(recorder.requests[0], {
        agentId: "a.boundary",
        projectId,
        brand: "pnpm",
        action: "run",
        command: "pnpm start",
        cwd: ".",
    });
    assert.equal(code(mixedFixture.call(host, ToolIds.workspaceProject, { projectId, action: "run", brand: "cmake" })), "unsupported_action");
    assert.equal(recorder.requests.length, 1);
});

test("project prefixes gradle commands with the checked-in wrapper only when gradlew exists", (): void => {
    const host: WorkspaceAgentService = gradleFixture.service();
    const wrapped: WorkspaceProjectSummary = summaryOf(
        data(gradleFixture.call(host, ToolIds.workspaceProject, { projectId: "project:packages/wrap" })),
        "project:packages/wrap",
    );
    const wrappedGradle: WorkspaceProjectBrand = brandOf(wrapped, "gradle");
    assert.deepEqual(wrappedGradle.actions, ["build", "compile", "run", "test"]);
    assert.equal(wrappedGradle.commands.build, "./gradlew build");
    assert.equal(wrappedGradle.commands.test, "./gradlew test");
    Object.values(wrappedGradle.commands).forEach((command: string): void => {
        assert.equal(command.startsWith("./gradlew "), true, command);
    });
    const plain: WorkspaceProjectSummary = summaryOf(
        data(gradleFixture.call(host, ToolIds.workspaceProject, { projectId: "project:packages/plain" })),
        "project:packages/plain",
    );
    const plainGradle: WorkspaceProjectBrand = brandOf(plain, "gradle");
    assert.equal(plainGradle.commands.build, "gradle build");
    assert.equal(plainGradle.commands.run, "gradle run");
    Object.values(plainGradle.commands).forEach((command: string): void => {
        assert.equal(command.startsWith("gradle "), true, command);
    });
});

test("project without a manifest detects unknown and rejects every execution action", (): void => {
    const recorder: RecordedRunner = recordingRunner();
    const host: WorkspaceAgentService = emptyFixture.service({ runner: recorder.runner });
    const projectId: string = "project:.";
    const detected: Record<string, unknown> = data(emptyFixture.call(host, ToolIds.workspaceProject, { projectId }));
    const summary: WorkspaceProjectSummary = summaryOf(detected, projectId);
    assert.equal(summary.brand, "unknown");
    assert.equal(summary.language, "unknown");
    assert.equal(summary.manifest, null);
    assert.deepEqual(summary.actions, []);
    assert.deepEqual(summary.commands, {});
    assert.deepEqual(summary.detected, []);
    ExecutionActions.forEach((action: Exclude<WorkspaceProjectAction, "detect">): void => {
        assert.equal(code(emptyFixture.call(host, ToolIds.workspaceProject, { projectId, action })), "invalid_arguments");
    });
    assert.equal(recorder.requests.length, 0);
});

test("project maps a hostile runner outcome to internal_error", (): void => {
    const outcomes: unknown[] = [
        { ok: true },
        { ok: true, exitCode: 1.5 },
        { ok: true, exitCode: Number.NaN },
        { ok: true, exitCode: "0" },
        { ok: true, exitCode: 0, stdout: 42 },
        { ok: true, exitCode: 0, durationMs: -1 },
        { ok: true, exitCode: 0, durationMs: Number.NaN },
        { ok: false, code: "internal_error" },
    ];
    outcomes.forEach((outcome: unknown): void => {
        const host: WorkspaceAgentService = singleFixture.service({ runner: hostileRunner(outcome) });
        assert.equal(
            code(singleFixture.call(host, ToolIds.workspaceProject, { projectId: "project:.", action: "build" })),
            "internal_error",
            JSON.stringify(outcome),
        );
    });
    const throwingHost: WorkspaceAgentService = singleFixture.service({ runner: throwingRunner });
    assert.equal(
        code(singleFixture.call(throwingHost, ToolIds.workspaceProject, { projectId: "project:.", action: "build" })),
        "internal_error",
    );
});

test("project returns empty output fields for a clean empty run", (): void => {
    const recorder: RecordedRunner = recordingRunner({ ok: true, exitCode: 0, stdout: "", stderr: "" });
    const host: WorkspaceAgentService = singleFixture.service({ runner: recorder.runner });
    const result: Record<string, unknown> = data(
        singleFixture.call(host, ToolIds.workspaceProject, { projectId: "project:.", action: "build" }),
    );
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
    assert.equal(result.stdoutTruncated, false);
    assert.equal(result.stderrTruncated, false);
    assert.equal(result.dryRun, false);
    assert.equal(Object.hasOwn(result, "durationMs"), false);
});

test("project keeps exactly the last configured runner output characters", (): void => {
    const stdout: string = "0123456789".repeat(2000);
    const recorder: RecordedRunner = recordingRunner({ ok: true, exitCode: 0, stdout, stderr: "" });
    const host: WorkspaceAgentService = singleFixture.service({ runner: recorder.runner, limits: { maxRunOutputChars: 8 } });
    const result: Record<string, unknown> = data(
        singleFixture.call(host, ToolIds.workspaceProject, { projectId: "project:.", action: "build" }),
    );
    assert.equal(stdout.length, 20000);
    assert.equal(result.stdout, "23456789");
    assert.equal((result.stdout as string).length, 8);
    assert.equal(result.stdoutTruncated, true);
    assert.equal(result.stderr, "");
    assert.equal(result.stderrTruncated, false);
});

test("outline keeps a project with an empty README and a childless file node", (): void => {
    const host: WorkspaceAgentService = emptyFixture.service();
    const result: Record<string, unknown> = data(emptyFixture.call(host, ToolIds.workspaceOutline));
    assert.equal(result.projects, 1);
    assert.equal(result.truncated, false);
    assert.equal(result.nodes, 2);
    const roots: WorkspaceOutlineNode[] = result.roots as WorkspaceOutlineNode[];
    assert.equal(roots.length, 1);
    const project: WorkspaceOutlineNode = roots[0];
    assert.equal(project.kind, "project");
    assert.equal(project.path, ".");
    assert.equal(project.childCount, 1);
    assert.equal(project.children.length, 1);
    const file: WorkspaceOutlineNode = project.children[0];
    assert.equal(file.kind, "file");
    assert.equal(file.path, "README.md");
    assert.equal(file.childCount, 0);
    assert.deepEqual(file.children, []);
});

test("outline accepts depth 0 and 12 and rejects out-of-range depth", (): void => {
    const host: WorkspaceAgentService = outlineFixture.service();
    const call: (args: Record<string, unknown>) => WorkspaceResponse = (args: Record<string, unknown>): WorkspaceResponse =>
        outlineFixture.call(host, ToolIds.workspaceOutline, args);
    const zero: Record<string, unknown> = data(call({ maxDepth: 0 }));
    assert.equal(zero.nodes, 1);
    assert.equal(zero.truncated, false);
    const root: WorkspaceOutlineNode = (zero.roots as WorkspaceOutlineNode[])[0];
    assert.equal(root.childCount, 4);
    assert.deepEqual(root.children, []);
    const twelve: Record<string, unknown> = data(call({ maxDepth: 12 }));
    assert.equal(twelve.truncated, false);
    assert.equal(twelve.nodes, flattenOutline(twelve.roots as WorkspaceOutlineNode[]).length);
    assert.equal(Number(twelve.nodes) > 1, true);
    assert.equal(code(call({ maxDepth: 13 })), "invalid_arguments");
    assert.equal(code(call({ maxDepth: -1 })), "invalid_arguments");
    assert.equal(code(call({ maxDepth: 1.5 })), "invalid_arguments");
});

test("outline accepts limit 2000 and reports truncation at limit 1", (): void => {
    const host: WorkspaceAgentService = outlineFixture.service();
    const call: (args: Record<string, unknown>) => WorkspaceResponse = (args: Record<string, unknown>): WorkspaceResponse =>
        outlineFixture.call(host, ToolIds.workspaceOutline, args);
    const one: Record<string, unknown> = data(call({ limit: 1 }));
    assert.equal(one.nodes, 1);
    assert.equal(one.truncated, true);
    const root: WorkspaceOutlineNode = (one.roots as WorkspaceOutlineNode[])[0];
    assert.equal(root.childCount, 4);
    assert.deepEqual(root.children, []);
    assert.equal(code(call({ limit: 2001 })), "invalid_arguments");
    const max: Record<string, unknown> = data(call({ limit: 2000 }));
    assert.equal(max.truncated, false);
    assert.equal(max.nodes, flattenOutline(max.roots as WorkspaceOutlineNode[]).length);
});

test("outline collapses symbols and matches only extensionless files for an empty extension", (): void => {
    const host: WorkspaceAgentService = outlineFixture.service();
    const collapsed: Record<string, unknown> = data(outlineFixture.call(host, ToolIds.workspaceOutline, { includeSymbols: false }));
    const collapsedFiles: WorkspaceOutlineNode[] = flattenOutline(collapsed.roots as WorkspaceOutlineNode[]).filter(
        (node: WorkspaceOutlineNode): boolean => node.kind === "file",
    );
    assert.equal(collapsedFiles.length, 4);
    collapsedFiles.forEach((file: WorkspaceOutlineNode): void => {
        assert.deepEqual(file.children, []);
        assert.equal(file.childCount, 0);
    });
    const extensionless: Record<string, unknown> = data(outlineFixture.call(host, ToolIds.workspaceOutline, { extension: "" }));
    const extensionlessFiles: WorkspaceOutlineNode[] = flattenOutline(extensionless.roots as WorkspaceOutlineNode[]).filter(
        (node: WorkspaceOutlineNode): boolean => node.kind === "file",
    );
    assert.deepEqual(
        extensionlessFiles.map((node: WorkspaceOutlineNode): string => node.path),
        ["LICENSE"],
    );
    const root: WorkspaceOutlineNode = (extensionless.roots as WorkspaceOutlineNode[])[0];
    assert.equal(root.childCount, 3);
});

test("outline pathPrefix keeps directories and drops files that do not match", (): void => {
    const host: WorkspaceAgentService = outlineFixture.service();
    const call: (args: Record<string, unknown>) => WorkspaceResponse = (args: Record<string, unknown>): WorkspaceResponse =>
        outlineFixture.call(host, ToolIds.workspaceOutline, args);
    const missing: Record<string, unknown> = data(call({ pathPrefix: "missing/" }));
    const missingRoot: WorkspaceOutlineNode = (missing.roots as WorkspaceOutlineNode[])[0];
    assert.deepEqual(
        flattenOutline(missing.roots as WorkspaceOutlineNode[])
            .filter((node: WorkspaceOutlineNode): boolean => node.kind === "file")
            .map((node: WorkspaceOutlineNode): string => node.path),
        [],
    );
    assert.equal(missingRoot.childCount, 2);
    assert.deepEqual(
        missingRoot.children.map((node: WorkspaceOutlineNode): string => node.path),
        ["docs", "src"],
    );
    missingRoot.children.forEach((node: WorkspaceOutlineNode): void => {
        assert.equal(node.kind, "directory");
        assert.equal(node.childCount, 0);
        assert.deepEqual(node.children, []);
    });
    const docs: Record<string, unknown> = data(call({ pathPrefix: "docs/" }));
    const docsRoot: WorkspaceOutlineNode = (docs.roots as WorkspaceOutlineNode[])[0];
    assert.equal(docsRoot.childCount, 2);
    const docsFiles: WorkspaceOutlineNode[] = flattenOutline(docs.roots as WorkspaceOutlineNode[]).filter(
        (node: WorkspaceOutlineNode): boolean => node.kind === "file",
    );
    assert.deepEqual(
        docsFiles.map((node: WorkspaceOutlineNode): string => node.path),
        ["docs/guide.md"],
    );
    const src: WorkspaceOutlineNode = docsRoot.children.find((node: WorkspaceOutlineNode): boolean => node.path === "src")!;
    assert.equal(src.childCount, 0);
});

test("outline excludes package entities and orders nodes by structure and source line", (): void => {
    const host: WorkspaceAgentService = outlineFixture.service();
    const result: Record<string, unknown> = data(outlineFixture.call(host, ToolIds.workspaceOutline));
    assert.equal(result.truncated, false);
    const roots: WorkspaceOutlineNode[] = result.roots as WorkspaceOutlineNode[];
    const all: WorkspaceOutlineNode[] = flattenOutline(roots);
    /**
     * The declared node kind excludes `package`, so the guard widens it: a
     * package entity that leaked into `children` would still be caught here.
     */
    assert.equal(all.some((node: WorkspaceOutlineNode): boolean => (node.kind as string) === "package"), false);
    assert.equal(all.some((node: WorkspaceOutlineNode): boolean => node.label === "lodash"), false);
    const project: WorkspaceOutlineNode = roots[0];
    assert.deepEqual(
        project.children.map((node: WorkspaceOutlineNode): string => node.kind),
        ["directory", "directory", "file", "file"],
    );
    assert.deepEqual(
        project.children.map((node: WorkspaceOutlineNode): string => node.path),
        ["docs", "src", "LICENSE", "package.json"],
    );
    all.forEach((node: WorkspaceOutlineNode): void => {
        assert.equal(node.childCount, node.children.length);
    });
    all.filter((node: WorkspaceOutlineNode): boolean => node.kind === "file").forEach((file: WorkspaceOutlineNode): void => {
        const starts: Array<number | undefined> = file.children.map((node: WorkspaceOutlineNode): number | undefined => node.startLine);
        const ascending: Array<number | undefined> = [...starts].sort(
            (left: number | undefined, right: number | undefined): number => (left ?? 0) - (right ?? 0),
        );
        assert.deepEqual(starts, ascending);
    });
    const guide: WorkspaceOutlineNode = all.find((node: WorkspaceOutlineNode): boolean => node.path === "docs/guide.md")!;
    assert.deepEqual(
        guide.children.map((node: WorkspaceOutlineNode): string => node.label),
        ["Alpha", "Beta"],
    );
    assert.deepEqual(
        guide.children.map((node: WorkspaceOutlineNode): number | undefined => node.startLine),
        [1, 3],
    );
});

test("dependency reports empty directions for a project without manifest edges", (): void => {
    const host: WorkspaceAgentService = lonelyFixture.service();
    const result: Record<string, unknown> = data(
        lonelyFixture.call(host, ToolIds.workspaceDependency, { projectId: "project:." }),
    );
    assert.equal(result.total, 1);
    assert.equal(result.nextOffset, null);
    const row: WorkspaceProjectDependency = dependencyRows(result)[0];
    assert.equal(row.projectId, "project:.");
    assert.deepEqual(row.dependencies, []);
    assert.deepEqual(row.dependents, []);
});

test("dependency keeps a self edge in both directions", (): void => {
    const host: WorkspaceAgentService = selfFixture.service();
    const result: Record<string, unknown> = data(
        selfFixture.call(host, ToolIds.workspaceDependency, { projectId: "project:." }),
    );
    const row: WorkspaceProjectDependency = dependencyRows(result)[0];
    assert.equal(row.dependencies.length, 1);
    assert.equal(row.dependents.length, 1);
    const selfEdge: WorkspaceDependencyEdge = row.dependencies[0];
    assert.equal(selfEdge.id, "project:.");
    assert.equal(selfEdge.kind, "project");
    assert.equal(selfEdge.label, "self");
    assert.equal(selfEdge.path, "package.json");
    assert.equal(selfEdge.method, "manifest");
    assert.equal(Object.hasOwn(selfEdge, "line"), false);
    assert.deepEqual(edgeIds(row.dependents), ["project:."]);
});

test("dependency returns both sides of a project cycle", (): void => {
    const host: WorkspaceAgentService = cycleFixture.service();
    const rootResult: Record<string, unknown> = data(
        cycleFixture.call(host, ToolIds.workspaceDependency, { projectId: "project:." }),
    );
    const rootRow: WorkspaceProjectDependency = dependencyRows(rootResult)[0];
    assert.deepEqual(edgeIds(rootRow.dependencies), ["project:packages/app"]);
    assert.deepEqual(edgeIds(rootRow.dependents), ["project:packages/app"]);
    const appResult: Record<string, unknown> = data(
        cycleFixture.call(host, ToolIds.workspaceDependency, { projectId: "project:packages/app" }),
    );
    const appRow: WorkspaceProjectDependency = dependencyRows(appResult)[0];
    assert.deepEqual(edgeIds(appRow.dependencies), ["project:."]);
    assert.deepEqual(edgeIds(appRow.dependents), ["project:."]);
});

test("dependency collapses duplicate declarations to one edge per target", (): void => {
    const host: WorkspaceAgentService = duplicateFixture.service();
    const rootResult: Record<string, unknown> = data(
        duplicateFixture.call(host, ToolIds.workspaceDependency, { projectId: "project:." }),
    );
    const rootRow: WorkspaceProjectDependency = dependencyRows(rootResult)[0];
    assert.equal(rootRow.dependencies.length, 1);
    assert.deepEqual(edgeIds(rootRow.dependencies), ["project:packages/app"]);
    const appResult: Record<string, unknown> = data(
        duplicateFixture.call(host, ToolIds.workspaceDependency, { projectId: "project:packages/app" }),
    );
    const appRow: WorkspaceProjectDependency = dependencyRows(appResult)[0];
    assert.deepEqual(edgeIds(appRow.dependents), ["project:."]);
});

test("dependency separates local project edges from external manifest packages", (): void => {
    const host: WorkspaceAgentService = dependencyFixture.service();
    const result: Record<string, unknown> = data(
        dependencyFixture.call(host, ToolIds.workspaceDependency, { projectId: "project:." }),
    );
    const row: WorkspaceProjectDependency = dependencyRows(result)[0];
    assert.equal(row.dependencies.length, 2);
    const local: WorkspaceDependencyEdge = row.dependencies.find((edge: WorkspaceDependencyEdge): boolean => edge.kind === "project")!;
    assert.equal(local.id, "project:packages/app");
    assert.equal(local.label, "app");
    assert.equal(local.path, "packages/app/package.json");
    assert.equal(local.method, "manifest");
    assert.equal(Object.hasOwn(local, "line"), false);
    const external: WorkspaceDependencyEdge = row.dependencies.find((edge: WorkspaceDependencyEdge): boolean => edge.kind === "package")!;
    assert.equal(external.id, "package:[\"project:.\",\"lodash\"]");
    assert.equal(external.label, "lodash");
    assert.equal(external.path, "package.json");
    assert.equal(external.method, "manifest");
    assert.equal(Object.hasOwn(external, "line"), false);
});

test("dependency filters incoming, outgoing and both directions", (): void => {
    const host: WorkspaceAgentService = dependencyFixture.service();
    const call: (args: Record<string, unknown>) => WorkspaceResponse = (args: Record<string, unknown>): WorkspaceResponse =>
        dependencyFixture.call(host, ToolIds.workspaceDependency, { projectId: "project:packages/app", ...args });
    const both: WorkspaceProjectDependency = dependencyRows(data(call({})))[0];
    assert.deepEqual(edgeIds(both.dependencies), ["project:packages/lib"]);
    assert.deepEqual(edgeIds(both.dependents), ["project:."]);
    const incoming: WorkspaceProjectDependency = dependencyRows(data(call({ direction: "incoming" })))[0];
    assert.deepEqual(incoming.dependencies, []);
    assert.deepEqual(edgeIds(incoming.dependents), ["project:."]);
    const outgoing: WorkspaceProjectDependency = dependencyRows(data(call({ direction: "outgoing" })))[0];
    assert.deepEqual(edgeIds(outgoing.dependencies), ["project:packages/lib"]);
    assert.deepEqual(outgoing.dependents, []);
});

test("dependency pages the project list at its boundaries", (): void => {
    const host: WorkspaceAgentService = dependencyFixture.service();
    const call: (args: Record<string, unknown>) => WorkspaceResponse = (args: Record<string, unknown>): WorkspaceResponse =>
        dependencyFixture.call(host, ToolIds.workspaceDependency, args);
    const first: Record<string, unknown> = data(call({ limit: 1 }));
    assert.equal(first.total, 3);
    assert.equal(first.nextOffset, 1);
    assert.deepEqual(
        dependencyRows(first).map((row: WorkspaceProjectDependency): string => row.projectId),
        ["project:packages/app"],
    );
    const second: Record<string, unknown> = data(call({ offset: 1, limit: 1 }));
    assert.equal(second.total, 3);
    assert.equal(second.nextOffset, 2);
    assert.deepEqual(
        dependencyRows(second).map((row: WorkspaceProjectDependency): string => row.projectId),
        ["project:packages/lib"],
    );
    const last: Record<string, unknown> = data(call({ offset: 2, limit: 1 }));
    assert.equal(last.nextOffset, null);
    assert.deepEqual(
        dependencyRows(last).map((row: WorkspaceProjectDependency): string => row.projectId),
        ["project:."],
    );
    const atTotal: Record<string, unknown> = data(call({ offset: 3 }));
    assert.equal(atTotal.total, 3);
    assert.deepEqual(dependencyRows(atTotal), []);
    assert.equal(atTotal.nextOffset, null);
    const beyond: Record<string, unknown> = data(call({ offset: 99 }));
    assert.equal(beyond.total, 3);
    assert.deepEqual(dependencyRows(beyond), []);
    assert.equal(beyond.nextOffset, null);
    assert.equal(code(call({ limit: 201 })), "invalid_arguments");
    const max: Record<string, unknown> = data(call({ limit: 200 }));
    assert.equal(max.total, 3);
    assert.equal(dependencyRows(max).length, 3);
});

test("dependency rejects unknown and non-project project ids", (): void => {
    const host: WorkspaceAgentService = dependencyFixture.service();
    assert.equal(
        code(dependencyFixture.call(host, ToolIds.workspaceDependency, { projectId: "project:missing" })),
        "not_available",
    );
    assert.equal(
        code(dependencyFixture.call(host, ToolIds.workspaceDependency, { projectId: "file:package.json" })),
        "invalid_arguments",
    );
});
