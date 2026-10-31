#!/usr/bin/env node
/**
 * Exercise the workspace project, outline and dependency tools.
 *
 * Every area shares one fixture scanned through `scanStructuredWorkspace`, so
 * the assertions run over the same snapshot adapter a host uses instead of
 * hand-built entities.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { MemoryContentStore } from "../src/context/contentStore.ts";
import type { WorkspaceSnapshot } from "../src/context/workspace.ts";
import { WorkspaceAgentService } from "../src/context/workspaceService.ts";
import type { WorkspaceRunOutcome, WorkspaceRunRequest, WorkspaceRunner, WorkspaceServiceLimits } from "../src/context/workspaceService.ts";
import { ToolIds } from "../src/naming/index.ts";
import type {
    WorkspaceDependencyEdge,
    WorkspaceOutlineNode,
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

/**
 * One snapshot plus constructors bound to its revision. A test builds as many
 * services as it needs (to vary the runner or one limit) over the same
 * immutable snapshot.
 */
const fixtureOf: (files: readonly StructuredWorkspaceFile[], projectIds: readonly string[]) => Fixture = (
    files: readonly StructuredWorkspaceFile[],
    projectIds: readonly string[],
): Fixture => {
    const store: MemoryContentStore = new MemoryContentStore();
    const snapshot: WorkspaceSnapshot = scanStructuredWorkspace(files, store);
    const service: (options?: ServiceOptions) => WorkspaceAgentService = (options: ServiceOptions = {}): WorkspaceAgentService =>
        new WorkspaceAgentService({
            agentId: "a.checker",
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

interface RecordedRunner {
    runner: WorkspaceRunner;
    requests: WorkspaceRunRequest[];
}

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

const outlineNodeAt: (roots: readonly WorkspaceOutlineNode[], path: string) => WorkspaceOutlineNode | undefined = (
    roots: readonly WorkspaceOutlineNode[],
    path: string,
): WorkspaceOutlineNode | undefined => flattenOutline(roots).find((node: WorkspaceOutlineNode): boolean => node.path === path);

const dependencyRows: (result: Record<string, unknown>) => WorkspaceProjectDependency[] = (
    result: Record<string, unknown>,
): WorkspaceProjectDependency[] => result.projects as WorkspaceProjectDependency[];

/**
 * Root pnpm project that also proves Maven and CMake, plus one nested yarn
 * project and one nested plain-npm project.
 */
const detectionFixture: Fixture = fixtureOf(
    [
        { path: "package.json", content: '{"name":"root"}' },
        { path: "pnpm-lock.yaml", content: "lockfileVersion: '9.0'\n" },
        { path: "maven/pom.xml", content: "<project></project>\n" },
        { path: "cmake/CMakeLists.txt", content: "project(root)\n" },
        { path: "packages/app/package.json", content: '{"name":"app"}' },
        { path: "packages/app/yarn.lock", content: "# yarn lockfile v1\n" },
        { path: "packages/web/package.json", content: '{"name":"web"}' },
    ],
    ["project:.", "project:packages/app", "project:packages/web"],
);

/**
 * A yarn project beside a root project that is also detectable as CMake, so
 * one project offers both a runnable action and an unsupported one.
 */
const executionFixture: Fixture = fixtureOf(
    [
        { path: "package.json", content: '{"name":"runner"}' },
        { path: "CMakeLists.txt", content: "project(runner)\n" },
        { path: "packages/app/package.json", content: '{"name":"app"}' },
        { path: "packages/app/yarn.lock", content: "# yarn lockfile v1\n" },
    ],
    ["project:.", "project:packages/app"],
);

/** Project → src directory → TypeScript file → function, plus Markdown knowledge. */
const outlineFixture: Fixture = fixtureOf(
    [
        { path: "package.json", content: '{"name":"outline"}' },
        { path: "src/lib.ts", content: "export function add(left: number, right: number): number {\n    return left + right;\n}\n" },
        { path: "docs/guide.md", content: "# Guide\nIntro text.\n## Section\nSection body.\n" },
    ],
    ["project:."],
);

/** Root depends on a local project and an external package; the app depends on lib. */
const dependencyFixture: Fixture = fixtureOf(
    [
        { path: "package.json", content: '{"name":"root","dependencies":{"app":"workspace:*","lodash":"^4.17.21"}}' },
        { path: "packages/app/package.json", content: '{"name":"app","dependencies":{"lib":"workspace:*"}}' },
        { path: "packages/lib/package.json", content: '{"name":"lib"}' },
    ],
    ["project:.", "project:packages/app", "project:packages/lib"],
);

test("detection lists every evidenced brand and keeps the most specific one primary", (): void => {
    const host: WorkspaceAgentService = detectionFixture.service();
    const result: Record<string, unknown> = data(detectionFixture.call(host, ToolIds.workspaceProject));
    assert.equal(result.action, "detect");
    assert.equal(result.total, 3);
    const root: WorkspaceProjectSummary = summaryOf(result, "project:.");
    assert.equal(root.label, "root");
    assert.equal(root.brand, "pnpm");
    assert.equal(root.language, "typescript/javascript");
    assert.equal(root.cwd, ".");
    assert.deepEqual(root.manifest, { id: "file:package.json", path: "package.json" });
    assert.deepEqual(root.actions, ["build", "compile", "run", "test"]);
    assert.equal(root.commands.build, "pnpm run build");
    assert.deepEqual(
        root.detected.map((item: WorkspaceProjectBrand): string => item.brand),
        ["pnpm", "npm", "maven", "cmake"],
    );
    const maven: WorkspaceProjectBrand = brandOf(root, "maven");
    assert.equal(maven.language, "java");
    assert.deepEqual(maven.manifest, { id: "file:maven/pom.xml", path: "maven/pom.xml" });
    const cmake: WorkspaceProjectBrand = brandOf(root, "cmake");
    assert.equal(cmake.language, "c/c++");
    assert.deepEqual(cmake.manifest, { id: "file:cmake/CMakeLists.txt", path: "cmake/CMakeLists.txt" });
    const yarnProject: WorkspaceProjectSummary = summaryOf(result, "project:packages/app");
    assert.equal(yarnProject.brand, "yarn");
    assert.equal(yarnProject.cwd, "packages/app");
    assert.equal(yarnProject.commands.build, "yarn build");
    assert.deepEqual(
        yarnProject.detected.map((item: WorkspaceProjectBrand): string => item.brand),
        ["yarn", "npm"],
    );
    const npmProject: WorkspaceProjectSummary = summaryOf(result, "project:packages/web");
    assert.equal(npmProject.brand, "npm");
    assert.equal(npmProject.cwd, "packages/web");
    assert.equal(npmProject.commands.build, "npm run build");
});

test("detection scopes to one project and rejects unknown or non-project ids", (): void => {
    const host: WorkspaceAgentService = detectionFixture.service();
    const scoped: Record<string, unknown> = data(
        detectionFixture.call(host, ToolIds.workspaceProject, { projectId: "project:packages/app" }),
    );
    assert.equal(scoped.total, 1);
    const scopedIds: string[] = (scoped.projects as WorkspaceProjectSummary[]).map(
        (project: WorkspaceProjectSummary): string => project.projectId,
    );
    assert.deepEqual(scopedIds, ["project:packages/app"]);
    assert.equal(code(detectionFixture.call(host, ToolIds.workspaceProject, { projectId: "project:missing" })), "not_available");
    assert.equal(code(detectionFixture.call(host, ToolIds.workspaceProject, { projectId: "file:package.json" })), "invalid_arguments");
});

test("execution runs the detected brand command through the host runner and dryRun skips it", (): void => {
    const recorder: RecordedRunner = recordingRunner({ ok: true, exitCode: 0, stdout: "built", stderr: "", durationMs: 25 });
    const host: WorkspaceAgentService = executionFixture.service({ runner: recorder.runner });
    const result: Record<string, unknown> = data(
        executionFixture.call(host, ToolIds.workspaceProject, { projectId: "project:packages/app", action: "build" }),
    );
    assert.deepEqual(result, {
        projectId: "project:packages/app",
        brand: "yarn",
        action: "build",
        command: "yarn build",
        cwd: "packages/app",
        dryRun: false,
        exitCode: 0,
        durationMs: 25,
        stdout: "built",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
    });
    assert.deepEqual(recorder.requests, [
        {
            agentId: "a.checker",
            projectId: "project:packages/app",
            brand: "yarn",
            action: "build",
            command: "yarn build",
            cwd: "packages/app",
        },
    ]);
    const dry: Record<string, unknown> = data(
        executionFixture.call(host, ToolIds.workspaceProject, { projectId: "project:packages/app", action: "build", dryRun: true }),
    );
    assert.deepEqual(dry, {
        projectId: "project:packages/app",
        brand: "yarn",
        action: "build",
        command: "yarn build",
        cwd: "packages/app",
        dryRun: true,
    });
    assert.equal(recorder.requests.length, 1);
});

test("execution rejects unavailable runners, unsupported actions, unknown brands and ambiguous scope", (): void => {
    const recorder: RecordedRunner = recordingRunner();
    const host: WorkspaceAgentService = executionFixture.service({ runner: recorder.runner });
    assert.equal(
        code(executionFixture.call(host, ToolIds.workspaceProject, { projectId: "project:.", brand: "cmake", action: "run" })),
        "unsupported_action",
    );
    assert.equal(recorder.requests.length, 0);
    assert.equal(
        code(executionFixture.call(host, ToolIds.workspaceProject, { projectId: "project:packages/app", brand: "unknown", action: "build" })),
        "invalid_arguments",
    );
    assert.equal(code(executionFixture.call(host, ToolIds.workspaceProject, { action: "build" })), "invalid_arguments");
    assert.equal(code(executionFixture.call(host, ToolIds.workspaceProject, { projectId: "project:missing", action: "build" })), "not_available");
    assert.equal(code(executionFixture.call(host, ToolIds.workspaceProject, { projectId: "file:package.json", action: "build" })), "invalid_arguments");
    assert.equal(recorder.requests.length, 0);
    const withoutRunner: WorkspaceAgentService = executionFixture.service();
    assert.equal(
        code(executionFixture.call(withoutRunner, ToolIds.workspaceProject, { projectId: "project:packages/app", action: "build" })),
        "run_unavailable",
    );
    const refusing: RecordedRunner = recordingRunner({ ok: false, code: "run_unavailable" });
    const refusingHost: WorkspaceAgentService = executionFixture.service({ runner: refusing.runner });
    assert.equal(
        code(executionFixture.call(refusingHost, ToolIds.workspaceProject, { projectId: "project:packages/app", action: "test" })),
        "run_unavailable",
    );
    assert.deepEqual(refusing.requests.map((request: WorkspaceRunRequest): string => request.command), ["yarn test"]);
});

test("execution clips captured output to the last configured characters", (): void => {
    const output: string = "0123456789abcdef";
    const recorder: RecordedRunner = recordingRunner({ ok: true, exitCode: 1, stdout: output, stderr: output, durationMs: 3 });
    const host: WorkspaceAgentService = executionFixture.service({ runner: recorder.runner, limits: { maxRunOutputChars: 8 } });
    const result: Record<string, unknown> = data(
        executionFixture.call(host, ToolIds.workspaceProject, { projectId: "project:packages/app", action: "build" }),
    );
    assert.equal(result.stdout, "89abcdef");
    assert.equal(result.stderr, "89abcdef");
    assert.equal(result.stdoutTruncated, true);
    assert.equal(result.stderrTruncated, true);
    assert.equal(result.exitCode, 1);
    assert.equal(result.durationMs, 3);
});

test("outline cascades project, directory, file, symbol and knowledge nodes", (): void => {
    const host: WorkspaceAgentService = outlineFixture.service();
    const result: Record<string, unknown> = data(outlineFixture.call(host, ToolIds.workspaceOutline));
    assert.equal(result.projects, 1);
    assert.equal(result.truncated, false);
    const roots: WorkspaceOutlineNode[] = result.roots as WorkspaceOutlineNode[];
    assert.equal(roots.length, 1);
    assert.equal(result.nodes, flattenOutline(roots).length);
    const project: WorkspaceOutlineNode = roots[0];
    assert.equal(project.kind, "project");
    assert.equal(project.label, "outline");
    assert.equal(project.path, "package.json");
    assert.equal(project.childCount, 3);
    assert.deepEqual(
        project.children.map((node: WorkspaceOutlineNode): string => node.label),
        ["docs", "src", "package.json"],
    );
    const docs: WorkspaceOutlineNode = project.children[0];
    assert.equal(docs.kind, "directory");
    assert.equal(docs.path, "docs");
    assert.equal(docs.childCount, 1);
    const guide: WorkspaceOutlineNode = docs.children[0];
    assert.equal(guide.kind, "file");
    assert.equal(guide.path, "docs/guide.md");
    assert.equal(guide.structureKind, "document");
    assert.deepEqual(
        guide.children.map((node: WorkspaceOutlineNode): string => node.kind),
        ["knowledge"],
    );
    const title: WorkspaceOutlineNode = guide.children[0];
    assert.equal(title.kind, "knowledge");
    assert.equal(title.label, "Guide");
    assert.equal(title.startLine, 1);
    assert.equal(title.endLine, 2);
    assert.equal(title.structureKind, "section");
    const section: WorkspaceOutlineNode = title.children[0];
    assert.equal(section.label, "Section");
    assert.equal(section.startLine, 3);
    assert.equal(section.endLine, 5);
    assert.equal(section.childCount, 0);
    const src: WorkspaceOutlineNode = project.children[1];
    assert.equal(src.kind, "directory");
    assert.equal(src.path, "src");
    assert.equal(src.childCount, 1);
    const lib: WorkspaceOutlineNode = src.children[0];
    assert.equal(lib.kind, "file");
    assert.equal(lib.path, "src/lib.ts");
    assert.deepEqual(
        lib.children.map((node: WorkspaceOutlineNode): string => node.label),
        ["add"],
    );
    const add: WorkspaceOutlineNode = lib.children[0];
    assert.equal(add.kind, "symbol");
    assert.equal(add.path, "src/lib.ts");
    assert.equal(add.startLine, 1);
    assert.equal(add.endLine, 3);
    assert.equal(add.childCount, 0);
});

test("outline bounds depth and node count while keeping untruncated child counts", (): void => {
    const host: WorkspaceAgentService = outlineFixture.service();
    const rootOnly: Record<string, unknown> = data(outlineFixture.call(host, ToolIds.workspaceOutline, { maxDepth: 0 }));
    const rootNode: WorkspaceOutlineNode = (rootOnly.roots as WorkspaceOutlineNode[])[0];
    assert.equal(rootOnly.nodes, 1);
    assert.equal(rootNode.childCount, 3);
    assert.deepEqual(rootNode.children, []);
    const shallow: Record<string, unknown> = data(outlineFixture.call(host, ToolIds.workspaceOutline, { maxDepth: 1 }));
    const shallowRoot: WorkspaceOutlineNode = (shallow.roots as WorkspaceOutlineNode[])[0];
    assert.equal(shallowRoot.childCount, 3);
    assert.equal(shallowRoot.children.length, 3);
    const docs: WorkspaceOutlineNode = shallowRoot.children.find((node: WorkspaceOutlineNode): boolean => node.path === "docs")!;
    assert.equal(docs.childCount, 1);
    assert.deepEqual(docs.children, []);
    const src: WorkspaceOutlineNode = shallowRoot.children.find((node: WorkspaceOutlineNode): boolean => node.path === "src")!;
    assert.equal(src.childCount, 1);
    assert.deepEqual(src.children, []);
    const cut: Record<string, unknown> = data(outlineFixture.call(host, ToolIds.workspaceOutline, { limit: 2 }));
    assert.equal(cut.nodes, 2);
    assert.equal(cut.truncated, true);
    const cutRoot: WorkspaceOutlineNode = (cut.roots as WorkspaceOutlineNode[])[0];
    assert.deepEqual(
        cutRoot.children.map((node: WorkspaceOutlineNode): string => node.path),
        ["docs"],
    );
    const full: Record<string, unknown> = data(outlineFixture.call(host, ToolIds.workspaceOutline));
    assert.equal(full.truncated, false);
    assert.equal(full.nodes, flattenOutline(full.roots as WorkspaceOutlineNode[]).length);
});

test("outline filters symbols and files by includeSymbols, extension and pathPrefix", (): void => {
    const host: WorkspaceAgentService = outlineFixture.service();
    const collapsed: Record<string, unknown> = data(outlineFixture.call(host, ToolIds.workspaceOutline, { includeSymbols: false }));
    const collapsedFiles: WorkspaceOutlineNode[] = flattenOutline(collapsed.roots as WorkspaceOutlineNode[]).filter(
        (node: WorkspaceOutlineNode): boolean => node.kind === "file",
    );
    assert.equal(collapsedFiles.length, 3);
    collapsedFiles.forEach((file: WorkspaceOutlineNode): void => {
        assert.deepEqual(file.children, []);
        assert.equal(file.childCount, 0);
    });
    const tsOnly: Record<string, unknown> = data(outlineFixture.call(host, ToolIds.workspaceOutline, { extension: ".ts" }));
    assert.deepEqual(
        flattenOutline(tsOnly.roots as WorkspaceOutlineNode[])
            .filter((node: WorkspaceOutlineNode): boolean => node.kind === "file")
            .map((node: WorkspaceOutlineNode): string => node.path),
        ["src/lib.ts"],
    );
    const upperCase: Record<string, unknown> = data(outlineFixture.call(host, ToolIds.workspaceOutline, { extension: ".TS" }));
    assert.equal(outlineNodeAt(upperCase.roots as WorkspaceOutlineNode[], "docs/guide.md"), (void 0));
    assert.ok(outlineNodeAt(upperCase.roots as WorkspaceOutlineNode[], "src/lib.ts"));
    const mdOnly: Record<string, unknown> = data(outlineFixture.call(host, ToolIds.workspaceOutline, { extension: "md" }));
    assert.deepEqual(
        flattenOutline(mdOnly.roots as WorkspaceOutlineNode[])
            .filter((node: WorkspaceOutlineNode): boolean => node.kind === "file")
            .map((node: WorkspaceOutlineNode): string => node.path),
        ["docs/guide.md"],
    );
    const prefixed: Record<string, unknown> = data(outlineFixture.call(host, ToolIds.workspaceOutline, { pathPrefix: "src/" }));
    assert.deepEqual(
        flattenOutline(prefixed.roots as WorkspaceOutlineNode[])
            .filter((node: WorkspaceOutlineNode): boolean => node.kind === "file")
            .map((node: WorkspaceOutlineNode): string => node.path),
        ["src/lib.ts"],
    );
    assert.equal(outlineNodeAt(prefixed.roots as WorkspaceOutlineNode[], "src/lib.ts")!.children[0].label, "add");
});

test("dependency reports project and package edges in both directions", (): void => {
    const host: WorkspaceAgentService = dependencyFixture.service();
    const rootResult: Record<string, unknown> = data(
        dependencyFixture.call(host, ToolIds.workspaceDependency, { projectId: "project:." }),
    );
    assert.equal(rootResult.total, 1);
    assert.equal(rootResult.nextOffset, null);
    const rootRow: WorkspaceProjectDependency = dependencyRows(rootResult)[0];
    assert.equal(rootRow.projectId, "project:.");
    assert.equal(rootRow.label, "root");
    assert.deepEqual(rootRow.dependents, []);
    assert.equal(rootRow.dependencies.length, 2);
    const projectEdge: WorkspaceDependencyEdge = rootRow.dependencies.find(
        (edge: WorkspaceDependencyEdge): boolean => edge.kind === "project",
    )!;
    assert.equal(projectEdge.id, "project:packages/app");
    assert.equal(projectEdge.label, "app");
    assert.equal(projectEdge.path, "packages/app/package.json");
    assert.equal(projectEdge.method, "manifest");
    assert.equal(projectEdge.line, (void 0));
    const packageEdge: WorkspaceDependencyEdge = rootRow.dependencies.find(
        (edge: WorkspaceDependencyEdge): boolean => edge.kind === "package",
    )!;
    assert.equal(packageEdge.id, 'package:["project:.","lodash"]');
    assert.equal(packageEdge.label, "lodash");
    assert.equal(packageEdge.path, "package.json");
    assert.equal(packageEdge.method, "manifest");
    const appResult: Record<string, unknown> = data(
        dependencyFixture.call(host, ToolIds.workspaceDependency, { projectId: "project:packages/app" }),
    );
    const appRow: WorkspaceProjectDependency = dependencyRows(appResult)[0];
    assert.deepEqual(
        appRow.dependencies.map((edge: WorkspaceDependencyEdge): string => edge.id),
        ["project:packages/lib"],
    );
    assert.deepEqual(
        appRow.dependents.map((edge: WorkspaceDependencyEdge): string => edge.id),
        ["project:."],
    );
    assert.equal(appRow.dependents[0].label, "root");
    assert.equal(appRow.dependents[0].path, "package.json");
});

test("dependency filters direction and pages the project list", (): void => {
    const host: WorkspaceAgentService = dependencyFixture.service();
    const outgoing: Record<string, unknown> = data(
        dependencyFixture.call(host, ToolIds.workspaceDependency, { projectId: "project:packages/app", direction: "outgoing" }),
    );
    const outgoingRow: WorkspaceProjectDependency = dependencyRows(outgoing)[0];
    assert.deepEqual(outgoingRow.dependents, []);
    assert.deepEqual(
        outgoingRow.dependencies.map((edge: WorkspaceDependencyEdge): string => edge.id),
        ["project:packages/lib"],
    );
    const incoming: Record<string, unknown> = data(
        dependencyFixture.call(host, ToolIds.workspaceDependency, { projectId: "project:packages/app", direction: "incoming" }),
    );
    const incomingRow: WorkspaceProjectDependency = dependencyRows(incoming)[0];
    assert.deepEqual(incomingRow.dependencies, []);
    assert.deepEqual(
        incomingRow.dependents.map((edge: WorkspaceDependencyEdge): string => edge.id),
        ["project:."],
    );
    const first: Record<string, unknown> = data(dependencyFixture.call(host, ToolIds.workspaceDependency, { limit: 1 }));
    assert.equal(first.total, 3);
    assert.equal(first.nextOffset, 1);
    assert.deepEqual(
        dependencyRows(first).map((row: WorkspaceProjectDependency): string => row.projectId),
        ["project:packages/app"],
    );
    const second: Record<string, unknown> = data(dependencyFixture.call(host, ToolIds.workspaceDependency, { offset: 1, limit: 1 }));
    assert.equal(second.total, 3);
    assert.equal(second.nextOffset, 2);
    assert.deepEqual(
        dependencyRows(second).map((row: WorkspaceProjectDependency): string => row.projectId),
        ["project:packages/lib"],
    );
    const last: Record<string, unknown> = data(dependencyFixture.call(host, ToolIds.workspaceDependency, { offset: 2, limit: 1 }));
    assert.equal(last.nextOffset, null);
    assert.deepEqual(
        dependencyRows(last).map((row: WorkspaceProjectDependency): string => row.projectId),
        ["project:."],
    );
});
