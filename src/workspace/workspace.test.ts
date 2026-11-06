import assert from "node:assert/strict";
import { test } from "node:test";
import { SynchronousOrderedMap } from "semantic-typescript";
import { InMemoryFileStorage } from "../file/core.ts";
import { Project } from "../project/core.ts";
import { Workspace, WorkspaceError } from "./core.ts";

function expectCode(action: () => unknown, code: WorkspaceError["code"]): void {
    assert.throws(action, (error: unknown) => error instanceof WorkspaceError && error.code === code);
}

function fixture() {
    const storage = new InMemoryFileStorage();
    storage.put({ tenantId: "tenant-a", rootId: "root-a", path: "notes.md" }, "base");
    return storage;
}

test("concurrent host change rejects stale baseline and preserves dirty buffer", () => {
    const storage = fixture();
    const first = new Workspace({ tenantId: "tenant-a", rootId: "root-a", storage }).mount("notes.md", { mode: "writable", owner: "one" });
    first.write("ours");
    storage.put({ tenantId: "tenant-a", rootId: "root-a", path: "notes.md" }, "theirs");
    expectCode(() => first.flush(), "stale");
    assert.equal(first.read(undefined, { allowStale: true }), "ours");
    assert.equal(first.dirty, true);
    assert.notEqual(first.snapshot().baseHash, storage.read({ tenantId: "tenant-a", rootId: "root-a", path: "notes.md" })?.hash);
});

test("dirty unmount/reload protects buffer and exposes base ours theirs", () => {
    const storage = fixture();
    const file = new Workspace({ tenantId: "tenant-a", rootId: "root-a", storage }).mount("notes.md", { mode: "writable", owner: "one" });
    file.write("ours");
    expectCode(() => file.unmount(), "dirty");
    expectCode(() => file.reload(), "dirty");
    storage.put({ tenantId: "tenant-a", rootId: "root-a", path: "notes.md" }, "theirs");
    assert.equal(file.conflict()?.ours, "ours");
    expectCode(() => file.flush(), "stale");
});

test("old fencing token cannot commit after lease replacement", () => {
    const storage = fixture();
    const first = new Workspace({ tenantId: "tenant-a", rootId: "root-a", storage }).mount("notes.md", { mode: "writable", owner: "one", leaseTtlMilliseconds: 1 });
    first.write("one");
    const lease = first.snapshot().lease;
    assert.ok(lease);
    storage.releaseLease(lease);
    new Workspace({ tenantId: "tenant-a", rootId: "root-a", storage }).mount("notes.md", { mode: "writable", owner: "two" });
    expectCode(() => first.flush(), "fence_rejected");
});

test("cross-root and cross-tenant references are rejected", () => {
    const storage = fixture();
    const otherRoot = new Workspace({ tenantId: "tenant-a", rootId: "root-b", storage });
    expectCode(() => otherRoot.mount("notes.md"), "not_found");
    const otherTenant = new Workspace({ tenantId: "tenant-b", rootId: "root-a", storage });
    expectCode(() => otherTenant.mount("notes.md"), "not_found");
    const project = new Project({ tenantId: "tenant-a", rootId: "root-a" });
    project.putRule({ id: "rule-1", tenantId: "tenant-a", rootId: "root-a", text: "rule" });
    assert.throws(() => project.putRule({ id: "rule-2", tenantId: "tenant-a", rootId: "root-b", text: "bad" }), (error: unknown) => error instanceof WorkspaceError && error.code === "invalid_scope");
});

test("project rules and six views are versioned projections with invalidation", () => {
    const project = new Project({ tenantId: "tenant-a", rootId: "root-a" });
    const rule = project.putRule({ id: "rule-1", tenantId: "tenant-a", rootId: "root-a", text: "v1" });
    const views = new SynchronousOrderedMap<string, "er" | "sequence" | "flow" | "venn" | "architecture" | "mindmap">();
    views.put("er", "er"); views.put("sequence", "sequence"); views.put("flow", "flow"); views.put("venn", "venn"); views.put("architecture", "architecture"); views.put("mindmap", "mindmap");
    views.forEach((_key, kind) => project.putView({ kind, tenantId: "tenant-a", rootId: "root-a", projection: { kind }, sourceRuleIds: [rule.id] }));
    assert.equal(project.listViews().length, 6);
    project.putRule({ id: rule.id, tenantId: "tenant-a", rootId: "root-a", text: "v2", expectedVersion: rule.version });
    assert.equal(project.getView("er")?.stale, true);
});
