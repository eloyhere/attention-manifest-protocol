#!/usr/bin/env node
/**
 * Agent-callable discovery: the `amp_tool_workspace_discover` tool must return
 * one structural tree, include project descriptions and host components, and
 * never expose a project outside the host's authorized `projectIds`.
 */
import assert from "node:assert/strict";

import { MemoryContentStore } from "../src/context/contentStore.ts";
import type { WorkspaceEntity, WorkspaceSnapshot } from "../src/context/workspace.ts";
import { WorkspaceAgentService } from "../src/context/workspaceService.ts";
import { HostCatalog } from "../src/discover/host.ts";
import { ToolIds } from "../src/naming/index.ts";
import type { WorkspaceResponse } from "../src/protocol/workspace.ts";

let Passed: number = 0;
let Failed: number = 0;

type SyncTest = (name: string, fn: () => void) => void;

const test: SyncTest = (name: string, fn: () => void): void => {
    try {
        fn();
        Passed++;
        console.log(`\x1b[32m✓\x1b[0m ${name}`);
    } catch (err) {
        Failed++;
        console.error(`\x1b[31m✗\x1b[0m ${name}\n      ${err.message}`);
    }
};

const Store: MemoryContentStore = new MemoryContentStore();
const Guide: string = "# Guide\nCHOSEN BODY\n## Details\nbounded discovery snippet";
const GuideRef: string = Store.put(Guide);
const Revision: string = "rev.discover-agent";

const entity: (id: string, kind: WorkspaceEntity["kind"], projectId: string, label: string, uri: string, parentId?: string, detailRef?: string) => WorkspaceEntity = (
    id: string,
    kind: WorkspaceEntity["kind"],
    projectId: string,
    label: string,
    uri: string,
    parentId?: string,
    detailRef?: string,
): WorkspaceEntity => ({
    id,
    kind,
    projectId,
    ...(parentId === (void 0) ? {} : { parentId }),
    label,
    summary: kind === "project" ? "Application project workspace" : "",
    source: { uri, revision: Revision },
    ...(detailRef === (void 0) ? {} : { detailRef }),
});

const Snapshot: WorkspaceSnapshot = {
    version: 1,
    revision: Revision,
    entities: [
        entity("project:app", "project", "project:app", "App", "project:app"),
        entity("dir:src", "directory", "project:app", "src", "src/", "project:app"),
        entity("file:app.service.ts", "file", "project:app", "app.service.ts", "src/app.service.ts", "dir:src"),
        entity("file:guide.md", "file", "project:app", "guide.md", "src/guide.md", "dir:src", GuideRef),
        entity("project:private", "project", "project:private", "Private", "project:private"),
    ],
    relations: [],
    diagnostics: [],
};

const Catalog: HostCatalog = new HostCatalog();
Catalog.addProject({
    id: "project:app",
    name: "App",
    description: "Application project",
    purpose: "Serve the demo app",
    summary: "A small authorized application project.",
});
Catalog.addProject({
    id: "project:private",
    name: "Private",
    description: "Should never be visible",
    purpose: "Hidden",
    summary: "Hidden",
});
Catalog.addPlugin({ id: "plugin:audit", name: "audit", description: "Audit plugin", purpose: "Record actions", status: "active" });
Catalog.addComponent({
    id: "service:private",
    kind: "service",
    name: "private",
    description: "Hidden service",
    purpose: "Hidden",
    projectId: "project:private",
});

const Service: WorkspaceAgentService = new WorkspaceAgentService({
    agentId: "a.discover",
    projectIds: ["project:app"],
    snapshot: Snapshot,
    store: Store,
    host: Catalog,
});

const data: (response: WorkspaceResponse) => Record<string, unknown> = (response: WorkspaceResponse): Record<string, unknown> => {
    assert.equal(response.ok, true, JSON.stringify(response));
    if (!response.ok) {
        throw new Error("expected success");
    }
    return response.data;
};

const findNode: (nodes: unknown[], label: string) => Record<string, unknown> | undefined = (nodes: unknown[], label: string): Record<string, unknown> | undefined => {
    for (let index: number = 0; index < nodes.length; index += 1) {
        const node: Record<string, unknown> = nodes[index] as Record<string, unknown>;
        if (node.label === label) {
            return node;
        }
        const nested: Record<string, unknown> | undefined = findNode((node.children as unknown[]) ?? [], label);
        if (nested !== (void 0)) {
            return nested;
        }
    }
    return undefined;
};

test("discover returns a host tree with project description, purpose and summary", () => {
    const result: Record<string, unknown> = data(Service.call(ToolIds.workspaceDiscover, { revision: Revision, limit: 50 }));
    const tree: Record<string, unknown> = result.tree as Record<string, unknown>;
    assert.equal(tree.kind, "host");
    const project: Record<string, unknown> | undefined = findNode(tree.children as unknown[], "App");
    assert.equal(project?.kind, "project");
    assert.equal(project?.description, "Application project");
    assert.equal(project?.purpose, "Serve the demo app");
    assert.equal(project?.summary, "A small authorized application project.");
});

test("discover finds file contents as bounded snippets", () => {
    const result: Record<string, unknown> = data(
        Service.call(ToolIds.workspaceDiscover, { revision: Revision, text: "CHOSEN BODY", content: true, scope: "projects", limit: 20 }),
    );
    const guide: Record<string, unknown> | undefined = findNode((result.tree as Record<string, unknown>).children as unknown[], "guide.md");
    assert.equal((guide?.contentMatches as unknown[] | undefined)?.length, 1);
    assert.match(JSON.stringify(result), /CHOSEN BODY/);
});

test("discover includes host plugins and the built-in workspace service", () => {
    const result: Record<string, unknown> = data(Service.call(ToolIds.workspaceDiscover, { revision: Revision, scope: "host", limit: 50 }));
    const plugins: Record<string, unknown> | undefined = findNode((result.tree as Record<string, unknown>).children as unknown[], "plugins");
    assert.equal((plugins?.children as unknown[] | undefined)?.length, 1);
    const services: Record<string, unknown> | undefined = findNode((result.tree as Record<string, unknown>).children as unknown[], "services");
    assert.ok((services?.children as unknown[] | undefined)?.some((node: unknown): boolean => (node as Record<string, unknown>).label === "amp.workspace"));
});

test("discover never exposes an unauthorized host project or component", () => {
    const result: Record<string, unknown> = data(Service.call(ToolIds.workspaceDiscover, { revision: Revision, limit: 100 }));
    const text: string = JSON.stringify(result);
    assert.doesNotMatch(text, /Should never be visible|Hidden service|project:private/);
});

console.log(`\n${Passed} passed, ${Failed} failed`);
if (Failed > 0) {
    process.exitCode = 1;
}
