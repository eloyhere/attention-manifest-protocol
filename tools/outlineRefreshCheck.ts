/**
 * "Changing a file updates its outline" end-to-end checks.
 *
 * The outline cache is keyed by content fingerprint. A write must therefore do
 * two things, not one: replace the previous generation with the outline of the
 * new content, and never leave a stale row that a later read could serve. This
 * check runs the real `FilesystemService` over a real SQLite store and a real
 * temporary directory, then inspects both the returned outline and the stored
 * rows.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { openStore, closeStore } from "../src/database/store/database.ts";
import type { DatabaseSync } from "node:sqlite";
import { SqliteWorkspaceSessionStore } from "../src/database/adapter/workspaceSessionStore.ts";
import { SqliteFilesystemStore } from "../src/database/adapter/filesystemStore.ts";
import { FilesystemService } from "../src/file/service.ts";
import type { FilesystemSession } from "../src/file/service.ts";
import { SessionRegistry } from "../src/session/registry.ts";
import type { OutlineNode, OutlineResult } from "../src/outline/types.ts";
import { outlineAddress, writeByteRequest } from "../src/outline/rangeBridge.ts";

const folder: string = mkdtempSync(join(tmpdir(), "amp-outline-refresh-"));
test.after((): void => {
    assert.equal(resolve(folder), folder);
    rmSync(folder, { recursive: true, force: true });
});

const labels: (result: OutlineResult) => string[] = (result: OutlineResult): string[] => {
    const out: string[] = [];
    const walk = (nodes: readonly OutlineNode[]): void => {
        for (const node of nodes) {
            if (!node.isFile) out.push(`${node.label}:${Number(node.range.startLine)}-${Number(node.range.endLine)}`);
            walk(node.children);
        }
    };
    walk(result.nodes);
    return out.sort();
};

/**
 * One service over a real store and a real workspace directory.
 */
const fixture = (dbPath: string): { session: FilesystemSession; store: SqliteFilesystemStore; db: DatabaseSync; key: string; } => {
    const db = openStore(dbPath);
    const store = new SqliteFilesystemStore(db);
    const registry = new SessionRegistry({ store: new SqliteWorkspaceSessionStore(db) });
    const service = new FilesystemService({ registry, store, timeZone: "utc" });
    const opened = registry.open({ agentId: "agent.outline", label: "outline refresh",
        roots: [{ id: "root.outline.refresh", path: folder, writable: true, exclude: [] }],
        permissions: { read: true, write: true, create: true, remove: false } });
    // The service persists under a session-qualified key; public root ids stay local.
    const key: string = JSON.stringify([opened.descriptor.workspaceId ?? "default", opened.descriptor.id, "root.outline.refresh"]);
    return { session: service.bind(opened.credential.sessionId, opened.credential.token), store, db, key };
};

test("writing a file replaces its cached outline in the same call", async (): Promise<void> => {
    const dbPath: string = join(folder, "state.sqlite");
    const { session, store, db, key } = fixture(dbPath);
    try {
        await session.write({ path: "sample.ts", content: "export const first = 1;\n", mode: "create" });
        const before: OutlineResult = session.outline({ path: "sample.ts" });
        assert.deepEqual(labels(before), ["first:1-1"]);
        const beforeFingerprint: string = before.fingerprint;
        assert.ok(store.loadOutline(key, "sample.ts", beforeFingerprint), "the write populates the cache");

        // A second write adds a symbol; the old generation must be gone.
        await session.write({ path: "sample.ts", content: "export const first = 1;\nexport function second() {\n  return 2;\n}\n", mode: "upsert" });
        const after: OutlineResult = session.outline({ path: "sample.ts" });
        assert.deepEqual(labels(after), ["first:1-1", "second:2-4"]);
        assert.notEqual(after.fingerprint, beforeFingerprint);
        assert.equal(store.loadOutline(key, "sample.ts", beforeFingerprint), (void 0), "no stale generation survives the write");
        assert.ok(store.loadOutline(key, "sample.ts", after.fingerprint), "the new content is cached immediately");
    } finally {
        closeStore(db);
    }
});

test("the outline after a write matches a fresh parse of the new content", async (): Promise<void> => {
    const dbPath: string = join(folder, "second.sqlite");
    const first = fixture(dbPath);
    let expected: string[] = [];
    try {
        await first.session.write({ path: "lib.rs", content: "pub fn one() {}\n", mode: "create" });
        first.session.outline({ path: "lib.rs" });
        await first.session.write({ path: "lib.rs", content: "pub fn one() {}\n\npub fn two() {}\n", mode: "upsert" });
        // Warm service (runtime tree already open) reads the cache that the write refreshed.
        const warm: OutlineResult = first.session.outline({ path: "lib.rs" });
        expected = labels(warm);
        assert.deepEqual(expected, ["one:1-1", "two:3-3"]);
    } finally {
        closeStore(first.db);
    }
    const second = fixture(dbPath);
    try {
        const cold: OutlineResult = second.session.outline({ path: "lib.rs" });
        assert.deepEqual(labels(cold), expected, "a cold service reads the same refreshed cache");
        assert.equal(cold.nodes[0].file?.fingerprint, second.store.loadOutline(second.key, "lib.rs", cold.fingerprint)?.fingerprint);
    } finally {
        closeStore(second.db);
    }
});

test("a node's outline range converts to the workspace write contract exactly", async (): Promise<void> => {
    const dbPath: string = join(folder, "range.sqlite");
    const { session, store, db, key } = fixture(dbPath);
    try {
        const source: string = "export const head = 0;\n\nexport function body() {\n  return 1;\n}\n";
        await session.write({ path: "range.ts", content: source, mode: "create" });
        const parsed: OutlineResult = session.outline({ path: "range.ts" });
        const body: OutlineNode | undefined = parsed.nodes[0].children.find((node: OutlineNode): boolean => node.label === "body");
        assert.ok(body, "the outline reports the function node");
        const address = outlineAddress(body.range, parsed.charset, { totalBytes: Buffer.byteLength(source, "utf8") });
        assert.deepEqual(address.lineRange, { startLine: 3, endLine: 5, lineCount: 3 });
        const { offsetBytes, endBytes } = writeByteRequest(address);
        // The workspace write tool splices exactly this half-open byte span.
        assert.equal(offsetBytes, Buffer.byteLength("export const head = 0;\n\n", "utf8"));
        assert.equal(endBytes, Buffer.byteLength(source, "utf8"));
        const encoded: Uint8Array = new TextEncoder().encode(source);
        assert.equal(new TextDecoder().decode(encoded.subarray(offsetBytes, endBytes)), "export function body() {\n  return 1;\n}\n");
        // Rewriting through the whole-file path refreshes the outline again.
        await session.write({ path: "range.ts", content: source.replace("return 1", "return 99"), mode: "upsert" });
        const reread: OutlineResult = session.outline({ path: "range.ts" });
        assert.ok(reread.fingerprint !== parsed.fingerprint);
        assert.deepEqual(labels(reread), ["body:3-5", "head:1-1"]);
        assert.equal(store.loadOutline(key, "range.ts", parsed.fingerprint), (void 0));
    } finally {
        closeStore(db);
    }
});

test("an unoutlinable file still writes and leaves no stale outline row", async (): Promise<void> => {
    const dbPath: string = join(folder, "binary.sqlite");
    const { session, store, db, key } = fixture(dbPath);
    try {
        await session.write({ path: "notes.md", content: "# Title\n\nbody\n", mode: "create" });
        const ready: OutlineResult = session.outline({ path: "notes.md" });
        assert.ok(store.loadOutline(key, "notes.md", ready.fingerprint));
        // A binary payload has no text outline; the write still succeeds and
        // must not leave the previous markdown generation cached.
        const binary: Uint8Array = new Uint8Array([0x00, 0xff, 0xfe, 0x01, 0x80]);
        await session.write({ path: "notes.md", content: binary as unknown as string, mode: "upsert" });
        assert.equal(store.loadOutline(key, "notes.md", ready.fingerprint), (void 0), "the rewritten file has no stale outline");
    } finally {
        closeStore(db);
    }
});
