import assert from "node:assert/strict";
import { test } from "node:test";
import { Optional, SynchronousOrderedMap } from "semantic-typescript";
import { fileDigest } from "./core.ts";
import { createFileTree, type FileTreeHost, type FileTreeMetadata, type FileTreeOperation, type FileTreeRead, type FileTreeScope } from "./tree.ts";

interface FixtureHost extends FileTreeHost {
    readonly calls: SynchronousOrderedMap<string, number>;
    bump(): void;
    deny(operation: FileTreeOperation, path?: string): void;
    failReads(count: number): void;
}

function fixture(): FixtureHost {
    const files = new SynchronousOrderedMap<string, { readonly content: string; readonly version: number; readonly hash: string }>();
    const directories = new SynchronousOrderedMap<string, readonly string[]>();
    const calls = new SynchronousOrderedMap<string, number>();
    const denied = new SynchronousOrderedMap<string, boolean>();
    const hashes = fileDigest;
    files.put("docs/readme.md", { content: "hello", version: 1, hash: hashes("hello") });
    files.put("docs/other.md", { content: "other", version: 1, hash: hashes("other") });
    directories.put("", ["docs"]);
    directories.put("docs", ["docs/readme.md", "docs/other.md"]);
    let revision = "r1";
    let readFailures = 0;
    const count = (key: string): void => { calls.put(key, (calls.get(key).orElse(0) as number) + 1); };
    const metadata = (path: string): Optional<FileTreeMetadata> => {
        count(`metadata:${path}`);
        if (path === "" || path === "docs") return Optional.of({ tenantId: "tenant-a", rootId: "root-a", path, kind: "directory", version: 1, hash: `directory:${path}`, revision });
        const file = files.get(path);
        return file.map(value => ({ tenantId: "tenant-a", rootId: "root-a", path, kind: "file" as const, version: value.version, hash: value.hash, revision }));
    };
    const host: FixtureHost = {
        calls,
        metadata,
        listChildren(scope: FileTreeScope): readonly FileTreeMetadata[] {
            count(`list:${scope.path}`);
            const children = directories.get(scope.path).orElse([]) as readonly string[];
            return children.map(path => metadata(path).get());
        },
        readFile(scope: FileTreeScope): FileTreeRead {
            count(`read:${scope.path}`);
            if (readFailures > 0) { readFailures -= 1; throw new Error("transient read"); }
            const file = files.get(scope.path).get();
            return { tenantId: "tenant-a", rootId: "root-a", path: scope.path, content: file.content, version: file.version, hash: file.hash, revision };
        },
        authorize(operation: FileTreeOperation, scope: FileTreeScope): boolean {
            count(`authorize:${operation}:${scope.path}`);
            return !denied.containsKey(`${operation}:${scope.path}`);
        },
        revision: () => revision,
        bump(): void { revision = revision === "r1" ? "r2" : "r3"; },
        deny(operation: FileTreeOperation, path = ""): void { denied.put(`${operation}:${path}`, true); },
        failReads(countValue: number): void { readFailures = countValue; },
    };
    return host;
}

test("root creation is metadata-only and child enumeration loads one level", () => {
    const host = fixture();
    const root = createFileTree(host, { tenantId: "tenant-a", rootId: "root-a" }).root();
    assert.equal(root.kind, "directory");
    assert.equal(host.calls.get("list:").orElse(0), 0);
    assert.equal(host.calls.get("read:docs/readme.md").orElse(0), 0);
    assert.ok(Object.keys(root).includes("children"));
    const json = JSON.parse(JSON.stringify(root)) as Record<string, unknown>;
    assert.equal("children" in json || "content" in json, false);
    assert.equal(host.calls.get("list:").get(0), 0);
    const children = root.children;
    assert.deepEqual(children.map(child => child.path), ["docs"]);
    assert.equal(host.calls.get("list:").orElse(0), 1);
    assert.equal(host.calls.get("list:docs").orElse(0), 0);
});

test("file content is delayed, cached, and authorization runs for every cached read", () => {
    const host = fixture();
    const docs = createFileTree(host, { tenantId: "tenant-a", rootId: "root-a" }).root().children[0]!;
    const file = docs.children[0]!;
    assert.equal(host.calls.get("read:docs/readme.md").orElse(0), 0);
    assert.equal(file.content, "hello");
    assert.equal(file.content, "hello");
    assert.equal(host.calls.get("read:docs/readme.md").orElse(0), 1);
    assert.equal(host.calls.get("authorize:metadata:docs/readme.md").orElse(0), 2);
    assert.ok((host.calls.get("authorize:read:docs/readme.md").get(0)) >= 2);
});

test("scope and path escape attempts are rejected", () => {
    assert.throws(() => createFileTree(fixture(), { tenantId: "tenant-a", rootId: "root-a", rootPath: "../docs" }), /Invalid workspace-relative/);
    const host = fixture();
    const badHost: FileTreeHost = {
        ...host,
        metadata: (path: string): Optional<FileTreeMetadata> => Optional.of({ tenantId: "tenant-b", rootId: "root-a", path, kind: "directory", version: 1, hash: "x", revision: "r1" }),
    };
    assert.throws(() => createFileTree(badHost, { tenantId: "tenant-a", rootId: "root-a" }).root(), /scope mismatch/);
});

test("source revision change rejects old proxy and refresh creates a new root", () => {
    const host = fixture();
    const tree = createFileTree(host, { tenantId: "tenant-a", rootId: "root-a" });
    const oldRoot = tree.root();
    host.bump();
    assert.throws(() => oldRoot.path, /source changed/);
    const newRoot = tree.refresh();
    assert.notEqual(newRoot, oldRoot);
    assert.equal(newRoot.path, "");
});

test("authorization denial applies to cached metadata and content", () => {
    const host = fixture();
    const file = createFileTree(host, { tenantId: "tenant-a", rootId: "root-a" }).root().children[0]!.children[0]!;
    assert.equal(file.content, "hello");
    const getter = Object.getOwnPropertyDescriptor(file, "content")!.get!;
    host.deny("read", "docs/readme.md");
    assert.throws(() => file.content, /authorization denied/);
    assert.throws(() => getter(), /authorization denied/);
    host.deny("metadata", "docs/readme.md");
    assert.throws(() => file.path, /authorization denied/);
});

test("loader errors are retryable because failed values are not cached", () => {
    const host = fixture();
    const file = createFileTree(host, { tenantId: "tenant-a", rootId: "root-a" }).root().children[0]!.children[0]!;
    host.failReads(1);
    assert.throws(() => file.content, /transient read/);
    assert.equal(file.content, "hello");
    assert.equal(host.calls.get("read:docs/readme.md").orElse(0), 2);
});
