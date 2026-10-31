#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { PathSandbox } from "../src/file/path.ts";
import type { SessionRoot } from "../src/session/types.ts";

const Base: string = mkdtempSync(join(tmpdir(), "amp-root-boundary-"));
try {
    const directory: string = join(Base, "authorized");
    const alias: string = join(Base, "alias");
    mkdirSync(directory);
    symlinkSync(directory, alias, process.platform === "win32" ? "junction" : "dir");

    test("root symlink is pinned to its real directory even for dot paths", (): void => {
        const sandbox: PathSandbox = new PathSandbox([{ id: "root", path: alias, writable: false, exclude: [] }]);
        assert.equal(sandbox.resolve(".", "read").absolute, realpathSync(directory));
        assert.equal(sandbox.defaultRoot().path, realpathSync(directory));
    });

    test("real and alias roots cannot claim the same directory twice", (): void => {
        assert.throws(
            () =>
                new PathSandbox([
                    { id: "real", path: directory, writable: false, exclude: [] },
                    { id: "alias", path: alias, writable: false, exclude: [] },
                ]),
            /duplicate session root/,
        );
    });

    test("caller mutations cannot change root access or exclusions", (): void => {
        const exclude: string[] = ["secret"];
        const root: SessionRoot = { id: "root", path: directory, writable: false, exclude };
        const sandbox: PathSandbox = new PathSandbox([root]);
        exclude.length = 0;
        (root as { writable: boolean; path: string }).writable = true;
        assert.equal(sandbox.defaultRoot().writable, false);
        (sandbox.defaultRoot() as { writable: boolean }).writable = true;
        (sandbox.listRoots()[0].exclude as string[]).length = 0;
        assert.throws(() => sandbox.resolve("secret", "read"), { code: "excluded_path" });
        assert.throws(() => sandbox.resolve("open", "write"), { code: "permission_denied" });
        const rooted = sandbox.resolve("open", "read");
        (rooted.root as { path: string }).path = Base;
        assert.throws(() => sandbox.revalidate(rooted), { code: "path_escape" });
        const escaped = { root: sandbox.defaultRoot(), relative: "../outside", absolute: join(Base, "outside") };
        assert.throws(() => sandbox.revalidate(escaped), { code: "path_escape" });
    });

    test("missing roots and file roots fail before any path resolution", (): void => {
        assert.throws(
            () => new PathSandbox([{ id: "missing", path: join(Base, "missing"), writable: false, exclude: [] }]),
            /invalid or inaccessible session root/,
        );
        assert.throws(
            () => new PathSandbox([{ id: "file", path: import.meta.filename, writable: false, exclude: [] }]),
            /invalid or inaccessible session root/,
        );
    });
} finally {
    // Node's test runner executes callbacks after module evaluation; cleanup is
    // registered as a test to keep fixture roots alive until all assertions run.
    test("cleanup sandbox fixtures", (): void => {
        rmSync(Base, { recursive: true, force: true });
    });
}
