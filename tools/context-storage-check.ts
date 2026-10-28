#!/usr/bin/env node
/**
 * Filesystem integration checks for content integrity and detail containment.
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { test } from "node:test";

import { FileDetailStore } from "../src/context/ast.ts";
import { FileContentStore } from "../src/context/contentStore.ts";

test("content refs deduplicate, survive reopening and reject malformed paths", (): void => {
    const root: string = mkdtempSync(join(tmpdir(), "amp-content-"));
    try {
        const dir: string = join(root, "store");
        const store: FileContentStore = new FileContentStore(dir);
        const ref: string = store.put("原文\ncontent");
        assert.equal(store.put("原文\ncontent"), ref);
        assert.equal(new FileContentStore(dir).get(ref), "原文\ncontent");
        writeFileSync(join(root, "outside.txt"), "outside");
        ["sha256:../outside", "sha256:..\\outside", "sha256:", `${ref}/../outside`, "other:hash"].forEach((invalid: string): void => {
            assert.equal(store.get(invalid), (void 0));
        });
        assert.equal(store.get(`sha256:${"0".repeat(64)}`), (void 0));
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("corrupted content fails on read and deduplicated write without overwriting evidence", (): void => {
    const root: string = mkdtempSync(join(tmpdir(), "amp-corrupt-"));
    try {
        const store: FileContentStore = new FileContentStore(root);
        const ref: string = store.put("original");
        const path: string = join(root, `${ref.slice(7)}.txt`);
        writeFileSync(path, "corrupted");
        assert.throws((): void => {
            store.get(ref);
        }, /integrity mismatch/);
        assert.throws((): void => {
            store.put("original");
        }, /integrity mismatch/);
        assert.equal(readFileSync(path, "utf8"), "corrupted");
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("detail IDs do not collide and normalized refs stay inside the store", (): void => {
    const root: string = mkdtempSync(join(tmpdir(), "amp-details-"));
    try {
        const dir: string = join(root, "store");
        const store: FileDetailStore = new FileDetailStore(relative(process.cwd(), dir));
        const first: string = store.put("a/b", "first");
        const second: string = store.put("a?b", "second");
        assert.notEqual(first, second);
        assert.equal(store.get(first), "first");
        assert.equal(store.get(second), "second");
        assert.equal(store.put("a/b", "updated"), first);
        assert.equal(store.get(first), "updated");
        writeFileSync(join(root, "outside.txt"), "outside");
        assert.equal(store.get(`${dir}/../outside.txt`), (void 0));
        assert.equal(store.get(`${dir}\\..\\outside.txt`), (void 0));
        assert.equal(store.get(join(root, "outside.txt")), (void 0));
        assert.equal(store.get(dir), (void 0));
        writeFileSync(join(dir, "legacy.txt"), "legacy");
        assert.equal(new FileDetailStore(dir).get(join(dir, "legacy.txt")), "legacy");
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("file symlinks cannot redirect detail or content reads and writes", (context): void => {
    const root: string = mkdtempSync(join(tmpdir(), "amp-links-"));
    try {
        const target: string = join(root, "outside.txt");
        const dir: string = join(root, "store");
        mkdirSync(dir);
        writeFileSync(target, "outside");
        try {
            symlinkSync(target, join(dir, "legacy.txt"), "file");
        } catch (error: unknown) {
            if (["EPERM", "EACCES", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")) {
                context.skip("file symlinks unavailable on this host");
                return;
            }
            throw error;
        }
        const details: FileDetailStore = new FileDetailStore(dir);
        assert.equal(details.get(join(dir, "legacy.txt")), (void 0));
        const ref: string = details.put("id", "inside");
        rmSync(ref);
        symlinkSync(target, join(dir, basename(ref)), "file");
        assert.equal(details.get(ref), (void 0));
        assert.throws((): void => {
            details.put("id", "overwrite");
        });
        const content: FileContentStore = new FileContentStore(dir);
        const hashRef: string = content.put("original");
        const hashPath: string = join(dir, `${hashRef.slice(7)}.txt`);
        rmSync(hashPath);
        symlinkSync(target, hashPath, "file");
        assert.equal(content.get(hashRef), (void 0));
        assert.throws((): void => {
            content.put("original");
        }, /invalid content store file/);
        assert.equal(readFileSync(target, "utf8"), "outside");
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
