import test from "node:test";
import assert from "node:assert/strict";
import { InMemoryFileStorage, createFileOutline } from "./file/index.ts";
import type { SourceVersion } from "./file/index.ts";
import { Workspace } from "./workspace/index.ts";
import { ProjectOutline } from "./project/index.ts";

test("file snapshots and project summaries retain source version across an edit", () => {
    const storage = new InMemoryFileStorage();
    const ref = { tenantId: "t", rootId: "r", path: "guide.md" };
    storage.put(ref, "# Intro\n## Detail\ntext");
    const file = new Workspace({ tenantId: "t", rootId: "r", storage }).mount("guide.md", { mode: "writable", owner: "test" });
    const captured = file.snapshot();
    const outline = createFileOutline(captured, file.read());
    const current: SourceVersion = { ...ref, contentHash: captured.hash, version: captured.version, bufferVersion: captured.bufferVersion };
    const detail = outline.find("Detail", current).get();
    assert.equal(outline.locate(2, current).get().id, detail.id);
    const project = new ProjectOutline({ tenantId: "t", rootId: "r", projectVersion: 1 });
    project.upsertBatch({ tenantId: "t", rootId: "r", expectedVersion: 1, upsert: [
        { tenantId: "t", rootId: "r", path: ".", type: "directory", name: "r", summary: "Project", hash: "root" },
        { ...ref, type: "file", name: "guide.md", summary: "Intro / Detail", hash: captured.hash, sourceRef: "file:guide.md", sourceVersion: 1 },
    ] });
    project.putProjection({ tenantId: "t", rootId: "r", id: "view", sourcePaths: ["guide.md"], payload: "Intro / Detail" });
    file.write("# Changed");
    file.flush();
    const updated = file.snapshot();
    assert.throws(() => outline.requireCurrent({ ...current, contentHash: updated.hash, version: updated.version, bufferVersion: updated.bufferVersion }), /stale/);
    project.updateSource({ ...ref, sourceRef: "file:guide.md", version: 2, hash: updated.hash, summary: "Changed" });
    assert.equal(project.currentProjection("view").isEmpty(), true);
});

test("duplicate Markdown slugs cannot collide with explicitly suffixed headings", () => {
    const storage = new InMemoryFileStorage();
    const source = storage.put({ tenantId: "t", rootId: "r", path: "headings.md" }, "# A\n# A\n# A-2");
    const outline = createFileOutline(source, source.content);
    assert.equal(outline.find("A").isPresent(), true);
    assert.equal(outline.find("A-2").isPresent(), true);
});

test("project outline rejects null bytes in a relative path", () => {
    const project = new ProjectOutline({ tenantId: "t", rootId: "r", projectVersion: 1 });
    assert.throws(() => project.find("src/a\0.ts"), /relative POSIX/);
});
