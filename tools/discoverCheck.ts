#!/usr/bin/env node
/**
 * Discovery tree, module classification, host catalog and content matching.
 */
import assert from "node:assert/strict";

import { HostCatalog } from "../src/discover/host.ts";
import { buildDiscoveryTree, classifyModule, extensionOf } from "../src/discover/index.ts";
import type { DiscoveryQuery, DiscoveryTree, HostComponent, HostProject } from "../src/discover/index.ts";
import type { WorkspaceEntity } from "../src/context/workspace.ts";

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

const Revision: string = "rev.discover";
const Contents: Record<string, string> = {
    "detail:user": "export class UserService {\n    charge(): string {\n        return \"billing\";\n    }\n}\n",
    "detail:readme": "# Demo\n\nA billing service for invoices.\n",
    "detail:settings": "export const config = { retries: 2 };\n",
};

const entity: (id: string, kind: WorkspaceEntity["kind"], label: string, uri: string, parentId?: string, detailRef?: string) => WorkspaceEntity = (
    id: string,
    kind: WorkspaceEntity["kind"],
    label: string,
    uri: string,
    parentId?: string,
    detailRef?: string,
): WorkspaceEntity => ({
    id,
    kind,
    projectId: "project:demo",
    ...(parentId === (void 0) ? {} : { parentId }),
    label,
    summary: kind === "project" ? "Demo project" : "",
    source: { uri, revision: Revision },
    ...(detailRef === (void 0) ? {} : { detailRef }),
});

const Entities: WorkspaceEntity[] = [
    entity("project:demo", "project", "Demo", "project:demo"),
    entity("dir:src", "directory", "src", "src/", "project:demo"),
    entity("dir:services", "directory", "services", "src/services/", "dir:src"),
    entity("dir:tools", "directory", "tools", "src/tools/", "dir:src"),
    entity("file:user.service.ts", "file", "user.service.ts", "src/services/user.service.ts", "dir:services", "detail:user"),
    entity("file:logs.tool.ts", "file", "logs.tool.ts", "src/tools/logs.tool.ts", "dir:tools"),
    entity("file:settings.config.ts", "file", "settings.config.ts", "src/settings.config.ts", "dir:src", "detail:settings"),
    entity("file:user.test.ts", "file", "user.test.ts", "src/user.test.ts", "dir:src"),
    entity("file:README.md", "file", "README.md", "README.md", "project:demo", "detail:readme"),
];

const Projects: HostProject[] = [
    {
        id: "project:demo",
        name: "Demo",
        description: "Demo service project",
        purpose: "Exercise the discovery module",
        summary: "A small project with service and tool modules.",
    },
    {
        id: "project:docs",
        name: "Docs",
        description: "Documentation project",
        purpose: "Explain the protocol",
        summary: "A registered project without a workspace tree.",
    },
];

const Components: HostComponent[] = [
    { id: "plugin:audit", kind: "plugin", name: "audit", description: "Audit plugin", purpose: "Record tool calls", status: "active" },
    { id: "service:billing", kind: "service", name: "billing", description: "Billing service", purpose: "Charge customers", status: "active" },
    { id: "tool:deploy", kind: "tool", name: "deploy", description: "Deploy tool", purpose: "Ship releases", status: "active" },
];

const BuiltIn: HostComponent[] = [
    { id: "amp_service_workspace", kind: "service", name: "amp.workspace", description: "Workspace service", purpose: "Serve workspace tools", status: "active" },
    { id: "amp_tool_workspace_discover", kind: "tool", name: "amp_tool_workspace_discover", description: "Discovery tool", purpose: "Discover modules", status: "active" },
];

const treeFor: (query?: DiscoveryQuery) => DiscoveryTree = (query: DiscoveryQuery = {}): DiscoveryTree =>
    buildDiscoveryTree({
        revision: Revision,
        entities: Entities,
        projects: Projects,
        components: Components,
        builtIn: BuiltIn,
        query,
        contentOf: (item: WorkspaceEntity): string | undefined => (item.detailRef === (void 0) ? undefined : Contents[item.detailRef]),
    });

const findNode: (nodes: readonly DiscoveryTree["tree"][], label: string) => DiscoveryTree["tree"] | undefined = (
    nodes: readonly DiscoveryTree["tree"][],
    label: string,
): DiscoveryTree["tree"] | undefined => {
    for (let index: number = 0; index < nodes.length; index += 1) {
        const node: DiscoveryTree["tree"] = nodes[index];
        if (node.label === label) {
            return node;
        }
        const nested: DiscoveryTree["tree"] | undefined = findNode(node.children, label);
        if (nested !== (void 0)) {
            return nested;
        }
    }
    return undefined;
};

test("classifies service, tool, config and test modules", () => {
    assert.equal(classifyModule(Entities[4]), "service");
    assert.equal(classifyModule(Entities[5]), "tool");
    assert.equal(classifyModule(Entities[6]), "config");
    assert.equal(classifyModule(Entities[7]), "test");
    assert.equal(classifyModule(Entities[0]), "unknown");
    const routeLike: WorkspaceEntity = {
        ...Entities[4],
        id: "file:route",
        label: "user.ts",
        source: { uri: "src/routes/user.ts", revision: Revision },
    };
    assert.equal(classifyModule(routeLike), "route");
    assert.equal(extensionOf("src/services/user.service.ts"), "ts");
    assert.equal(extensionOf("README"), undefined);
});

test("builds a host tree with project metadata and component groups", () => {
    const tree: DiscoveryTree = treeFor();
    assert.equal(tree.tree.kind, "host");
    assert.equal(tree.summary.projects, 2);
    assert.equal(tree.summary.plugins, 1);
    assert.equal(tree.summary.services, 2);
    assert.equal(tree.summary.tools, 2);
    const project: DiscoveryTree["tree"] | undefined = findNode(tree.tree.children, "Demo");
    assert.equal(project?.kind, "project");
    assert.equal(project?.description, "Demo service project");
    assert.equal(project?.purpose, "Exercise the discovery module");
    assert.equal(project?.summary, "A small project with service and tool modules.");
    const plugins: DiscoveryTree["tree"] | undefined = tree.tree.children.find((node): boolean => node.label === "plugins");
    const services: DiscoveryTree["tree"] | undefined = tree.tree.children.find((node): boolean => node.label === "services");
    assert.equal(plugins?.children.length, 1);
    assert.equal(services?.children.length, 2);
});

test("module filter keeps only matching files and their ancestors", () => {
    const tree: DiscoveryTree = treeFor({ scope: "projects", moduleKind: "service", limit: 100 });
    assert.equal(tree.summary.files, 1);
    assert.equal(tree.moduleCounts.service, 1);
    assert.equal(findNode(tree.tree.children, "user.service.ts")?.moduleKind, "service");
    assert.equal(findNode(tree.tree.children, "logs.tool.ts"), undefined);
});

test("content search finds a file whose name does not contain the query", () => {
    const tree: DiscoveryTree = treeFor({ scope: "projects", text: "invoices", content: true, limit: 100 });
    const readme: DiscoveryTree["tree"] | undefined = findNode(tree.tree.children, "README.md");
    assert.equal(readme?.contentMatches?.[0]?.line, 3);
    assert.match(readme?.contentMatches?.[0]?.text ?? "", /invoices/);
    assert.equal(tree.summary.matches, 1);
});

test("host-only scope returns registered components without projects", () => {
    const tree: DiscoveryTree = treeFor({ scope: "host", componentKind: "plugin" });
    assert.equal(tree.tree.children.some((node): boolean => node.label === "projects"), false);
    assert.equal(tree.summary.projects, 0);
    assert.equal(tree.summary.plugins, 1);
    assert.equal(tree.summary.services, 0);
});

test("project text matches the project node even without matching files", () => {
    const tree: DiscoveryTree = treeFor({ scope: "projects", text: "Exercise the discovery module", limit: 10 });
    const project: DiscoveryTree["tree"] | undefined = findNode(tree.tree.children, "Demo");
    assert.equal(project?.matched, true);
    assert.equal(project?.purpose, "Exercise the discovery module");
});

test("limit marks the tree truncated", () => {
    const tree: DiscoveryTree = treeFor({ scope: "projects", limit: 2 });
    assert.equal(tree.summary.truncated, true);
    assert.ok(tree.summary.nodes <= 2);
});

test("host catalog rejects duplicate and invalid registrations", () => {
    const catalog: HostCatalog = new HostCatalog();
    catalog.addProject(Projects[0]);
    assert.throws(() => catalog.addProject(Projects[0]));
    assert.throws(() => catalog.addComponent({ id: "plugin:bad", kind: "plugin", name: "bad", description: "" }));
    catalog.addPlugin({ id: "plugin:ok", name: "ok", description: "ok plugin" });
    assert.equal(catalog.components("plugin").length, 1);
});

console.log(`\n${Passed} passed, ${Failed} failed`);
if (Failed > 0) {
    process.exitCode = 1;
}
