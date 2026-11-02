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
import { GlobalAgentService } from "../src/global/service.ts";
import { HostCatalog } from "../src/discover/host.ts";
import { KnowledgeRegistry } from "../src/knowledge/registry.ts";
import { SkillRegistry } from "../src/skill/registry.ts";
import { ProtocolRegistry } from "../src/protocol/registry.ts";
import { ToolIds } from "../src/naming/index.ts";
import type { WorkspaceResponse } from "../src/protocol/workspace.ts";
import type { GlobalResponse } from "../src/protocol/global.ts";

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

const Skills: SkillRegistry = new SkillRegistry();
Skills.register({ id: "skill:lookup", name: "Look up knowledge", description: "Find protocol notes", instructions: "Private skill instructions", tags: ["protocol"] });
const Knowledge: KnowledgeRegistry = new KnowledgeRegistry();
Knowledge.register({ id: "knowledge:notes", title: "Protocol notes", summary: "Public metadata", content: "Private knowledge body", sourceUri: "docs/notes.md" });
const Protocols: ProtocolRegistry = new ProtocolRegistry();
Protocols.register({ id: "protocol:demo", name: "Demo protocol", version: "1.0", description: "Public protocol metadata", status: "deprecated", capabilities: ["discover"] });
Protocols.register({ id: "protocol:disabled", name: "Disabled protocol", version: "1.0", description: "Never exposed", status: "disabled" });

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
    skills: Skills,
    knowledge: Knowledge,
    protocols: Protocols,
});

const data: (response: WorkspaceResponse | GlobalResponse) => Record<string, unknown> = (response: WorkspaceResponse | GlobalResponse): Record<string, unknown> => {
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

test("discover includes registered skills and knowledge metadata only", () => {
    const result: Record<string, unknown> = data(Service.call(ToolIds.workspaceDiscover, { revision: Revision, limit: 50 }));
    const children: unknown[] = (result.tree as Record<string, unknown>).children as unknown[];
    const skill: Record<string, unknown> | undefined = findNode(children, "Look up knowledge");
    const knowledge: Record<string, unknown> | undefined = findNode(children, "Protocol notes");
    assert.equal(skill?.kind, "skill");
    assert.equal(knowledge?.kind, "knowledge");
    assert.equal(knowledge?.sourceUri, "docs/notes.md");
    assert.doesNotMatch(JSON.stringify(result), /Private skill instructions|Private knowledge body/);
    const scoped: Record<string, unknown> = data(Service.call(ToolIds.workspaceDiscover, { revision: Revision, scope: "skills", text: "protocol", limit: 20 }));
    assert.equal(findNode((scoped.tree as Record<string, unknown>).children as unknown[], "Look up knowledge")?.kind, "skill");
});

test("workspace and global discovery forward protocol metadata and exclude disabled entries", () => {
    const global = new GlobalAgentService({ agentId: "a.global", projectIds: ["project:app"], snapshot: Snapshot, store: Store, protocols: Protocols });
    for (const result of [
        data(Service.call(ToolIds.workspaceDiscover, { revision: Revision, scope: "protocols" })),
        data(global.call("amp_tool_global_discover", { revision: Revision, scope: "protocols" })),
    ]) {
        const nodes = (result.tree as Record<string, unknown>).children as unknown[];
        const protocol = findNode(nodes, "Demo protocol");
        assert.equal(protocol?.protocolStatus, "deprecated");
        assert.deepEqual(protocol?.capabilities, ["discover"]);
        assert.equal((result.summary as Record<string, unknown>).protocols, 1);
        assert.equal(findNode(nodes, "Disabled protocol"), undefined);
        assert.equal(findNode(nodes, "App"), undefined);
    }
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
