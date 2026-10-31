#!/usr/bin/env node
/**
 * Focused checks for the agent workspace tree: node shape, ordering, bigint
 * aggregation, wire projection, Merkle invalidation, annotations, exclusions,
 * symlink policy, traversal bounds and charset detection.
 *
 * Every fixture is a fresh directory under the host temp directory, and each
 * test removes it in a `finally` block so a failed assertion cannot leak state
 * into the next run.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { listDirectory } from "../src/file/directory.ts";
import { FilesystemError } from "../src/file/errors.ts";
import { buildFileNode, verifyFingerprint, wireNode, wireTree } from "../src/file/file.ts";
import { buildTree, WorkspaceTree } from "../src/file/tree.ts";
import type { DirectoryListing, DirectoryNode, FileNode, FilesystemErrorCode, TreeNode, TreeSnapshot, WireTreeNode } from "../src/file/types.ts";
import type { SessionRoot } from "../src/session/types.ts";

const fixture: () => string = (): string => mkdtempSync(join(tmpdir(), "amp-fs-tree-"));

const cleanup: (path: string) => void = (path: string): void => rmSync(path, { recursive: true, force: true });

const rootOf: (path: string) => SessionRoot = (path: string): SessionRoot => ({ id: "root.temp", path, writable: true, exclude: ["node_modules"] });

const write: (base: string, relative: string, content: string | Uint8Array) => void = (base: string, relative: string, content: string | Uint8Array): void => {
    const target: string = join(base, ...relative.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
};

const fileOf: (tree: WorkspaceTree, path: string) => FileNode = (tree: WorkspaceTree, path: string): FileNode => {
    const node: TreeNode | undefined = tree.node(path);
    if (node === (void 0) || node.type !== "File") {
        assert.fail(`${path} must be a file`);
    }
    return node;
};

const directoryOf: (tree: WorkspaceTree, path: string) => DirectoryNode = (tree: WorkspaceTree, path: string): DirectoryNode => {
    const node: TreeNode | undefined = tree.node(path);
    if (node === (void 0) || node.type !== "Directory") {
        assert.fail(`${path} must be a directory`);
    }
    return node;
};

const wellFormed: (value: string) => boolean = (value: string): boolean => {
    for (let index: number = 0; index < value.length; index += 1) {
        const code: number = value.charCodeAt(index);
        if (code >= 0xd800 && code <= 0xdbff) {
            const next: number = value.charCodeAt(index + 1);
            if (!(next >= 0xdc00 && next <= 0xdfff)) {
                return false;
            }
            index += 1;
        } else if (code >= 0xdc00 && code <= 0xdfff) {
            return false;
        }
    }
    return true;
};

const expectCode: (run: () => unknown, code: FilesystemErrorCode) => void = (run: () => unknown, code: FilesystemErrorCode): void => {
    let caught: unknown;
    try {
        run();
    } catch (error: unknown) {
        caught = error;
    }
    if (!(caught instanceof FilesystemError)) {
        assert.fail(`expected FilesystemError ${code}`);
    }
    assert.equal(caught.code, code);
};

test("directories sort before files and node shape is projected", (): void => {
    const directory: string = fixture();
    try {
        mkdirSync(join(directory, "zdir"));
        mkdirSync(join(directory, "adir"));
        write(directory, "a.txt", "alpha\n");
        write(directory, "b.txt", "beta\n");
        write(directory, "plain", "plain\n");
        const tree: WorkspaceTree = new WorkspaceTree(rootOf(directory), { timeZone: "utc" });
        const snapshot: TreeSnapshot = tree.snapshot();
        assert.deepEqual(
            snapshot.root.children.map((child: TreeNode): string => child.name),
            ["adir", "zdir", "a.txt", "b.txt", "plain"],
        );
        assert.equal(snapshot.root.type, "Directory");
        assert.equal(snapshot.root.path, ".");
        assert.equal(snapshot.root.name, ".");
        assert.equal(snapshot.root.extension, "directory");
        assert.equal(snapshot.root.charset, "none");
        assert.equal(Object.isFrozen(snapshot.root), true);
        assert.equal(Object.isFrozen(snapshot.root.children), true);
        assert.equal(Reflect.set(snapshot.root, "description", "mutated"), false);
        assert.equal(tree.children("a.txt").length, 0);
        const file: FileNode = fileOf(tree, "a.txt");
        assert.equal(file.children.length, 0);
        assert.equal(file.extension, "txt");
        assert.equal(file.charset, "utf-8");
        assert.match(file.create, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
        assert.match(file.modify, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
        assert.match(file.fingerprint, /^sha256:[0-9a-f]{64}$/);
        const plain: FileNode = fileOf(tree, "plain");
        assert.equal(plain.extension, "");
        const sub: DirectoryNode = directoryOf(tree, "adir");
        assert.equal(sub.extension, "directory");
        assert.equal(sub.charset, "none");
        assert.equal(sub.type, "Directory");
    } finally {
        cleanup(directory);
    }
});

test("bytes and lines aggregate as bigint and wire project as decimal strings", (): void => {
    const directory: string = fixture();
    try {
        write(directory, "a.txt", "one\ntwo\n");
        write(directory, "b.txt", "three");
        write(directory, "sub/c.txt", "x\n");
        const snapshot: TreeSnapshot = buildTree(rootOf(directory), { timeZone: "utc" });
        assert.equal(typeof(snapshot.root.bytes), "bigint");
        assert.equal(typeof(snapshot.root.lines), "bigint");
        assert.equal(snapshot.root.bytes, 15n);
        assert.equal(snapshot.root.lines, 4n);
        assert.equal(snapshot.stats.files, 3n);
        assert.equal(snapshot.stats.directories, 2n);
        assert.equal(snapshot.stats.bytes, 15n);
        assert.equal(snapshot.stats.lines, 4n);
        const sub: TreeNode | undefined = snapshot.root.children.find((child: TreeNode): boolean => child.name === "sub");
        if (sub === (void 0) || sub.type !== "Directory") {
            assert.fail("sub must be a directory");
        }
        assert.equal(sub.bytes, 2n);
        assert.equal(sub.lines, 1n);
        const wire: WireTreeNode = wireNode(snapshot.root);
        assert.equal(wire.bytes, "15");
        assert.equal(wire.lines, "4");
        assert.equal(wire.type, "Directory");
        assert.doesNotThrow((): string => JSON.stringify(wire));
        const oneLevel: WireTreeNode = wireTree(snapshot.root, 1, 0, 100);
        assert.equal(oneLevel.type, "Directory");
        if (oneLevel.type === "Directory") {
            assert.equal(oneLevel.children[0].type, "Directory");
            assert.equal(oneLevel.children[0].children.length, 0);
            assert.equal(oneLevel.children.length, 3);
        }
    } finally {
        cleanup(directory);
    }
});

test("refresh after a file write changes ancestors and the revision", (): void => {
    const directory: string = fixture();
    try {
        write(directory, "src/app.ts", "/** Version one. */\nexport const value = 1;\n");
        write(directory, "src/other.ts", "export const other = 1;\n");
        const tree: WorkspaceTree = new WorkspaceTree(rootOf(directory), { timeZone: "utc" });
        const first: TreeSnapshot = tree.snapshot();
        const firstApp: FileNode = fileOf(tree, "src/app.ts");
        const firstSource: DirectoryNode = directoryOf(tree, "src");
        write(directory, "src/app.ts", "/** Version two. */\nexport const value = 2;\n");
        const second: TreeSnapshot = tree.refresh("src/app.ts");
        const secondApp: FileNode = fileOf(tree, "src/app.ts");
        const secondSource: DirectoryNode = directoryOf(tree, "src");
        assert.notEqual(firstApp.fingerprint, secondApp.fingerprint);
        assert.notEqual(firstSource.fingerprint, secondSource.fingerprint);
        assert.notEqual(first.root.fingerprint, second.root.fingerprint);
        assert.notEqual(first.revision, second.revision);
        assert.equal(second.revision, tree.revision());
        assert.match(secondApp.summary, /Version two/);
    } finally {
        cleanup(directory);
    }
});

test("annotations override metadata without changing any fingerprint", (): void => {
    const directory: string = fixture();
    try {
        write(directory, "src/app.ts", "/** Original description. */\nexport const value = 1;\n");
        const root: SessionRoot = rootOf(directory);
        const plain: TreeSnapshot = buildTree(root, { timeZone: "utc" });
        const tree: WorkspaceTree = new WorkspaceTree(root, {
            timeZone: "utc",
            annotations: {
                src: { description: "Source directory", summary: "Custom source summary", purpose: "Hold source files" },
                "src/app.ts": { description: "Custom file description", summary: "Custom file summary", purpose: "Custom file purpose" },
            },
        });
        const annotated: TreeSnapshot = tree.snapshot();
        const file: FileNode = fileOf(tree, "src/app.ts");
        assert.equal(file.description, "Custom file description");
        assert.equal(file.summary, "Custom file summary");
        assert.equal(file.purpose, "Custom file purpose");
        const sub: DirectoryNode = directoryOf(tree, "src");
        assert.equal(sub.description, "Source directory");
        assert.equal(sub.summary, "Custom source summary");
        assert.equal(sub.purpose, "Hold source files");
        assert.equal(plain.root.fingerprint, annotated.root.fingerprint);
        assert.notEqual(plain.revision, annotated.revision);
    } finally {
        cleanup(directory);
    }
});

test("directory purpose comes from a direct README and annotation wins", (): void => {
    const directory: string = fixture();
    try {
        write(directory, "README.md", "# Project\n\nProject purpose text.\n");
        write(directory, "sub/README.md", "# Sub\n\nSub purpose text.\n");
        write(directory, "sub/plain.txt", "plain\n");
        const root: SessionRoot = rootOf(directory);
        const plain: TreeSnapshot = buildTree(root, { timeZone: "utc" });
        assert.equal(plain.root.purpose, "Project purpose text.");
        const sub: TreeNode | undefined = plain.root.children.find((child: TreeNode): boolean => child.name === "sub");
        if (sub === (void 0) || sub.type !== "Directory") {
            assert.fail("sub must be a directory");
        }
        assert.equal(sub.purpose, "Sub purpose text.");
        const annotated: WorkspaceTree = new WorkspaceTree(root, {
            timeZone: "utc",
            annotations: {
                ".": { purpose: "Root override" },
                sub: { description: "Sub description" },
            },
        });
        const annotatedSnapshot: TreeSnapshot = annotated.snapshot();
        assert.equal(annotatedSnapshot.root.purpose, "Root override");
        const annotatedSub: DirectoryNode = directoryOf(annotated, "sub");
        assert.equal(annotatedSub.description, "Sub description");
        assert.equal(annotatedSub.purpose, "Sub purpose text.");
        assert.equal(plain.root.fingerprint, annotatedSnapshot.root.fingerprint);
    } finally {
        cleanup(directory);
    }
});

test("hidden and excluded entries are skipped; symlinks are denied by default", (): void => {
    const directory: string = fixture();
    try {
        write(directory, ".hidden.txt", "hidden\n");
        write(directory, "node_modules/dep.js", "module.exports = 1;\n");
        write(directory, "ignored.txt", "ignored\n");
        write(directory, "visible.txt", "visible\n");
        write(directory, "target.txt", "target\n");
        let linked: boolean = true;
        try {
            symlinkSync(join(directory, "target.txt"), join(directory, "link.txt"));
        } catch {
            linked = false;
        }
        const root: SessionRoot = rootOf(directory);
        const tree: WorkspaceTree = new WorkspaceTree(root);
        assert.equal(tree.node(".hidden.txt"), undefined);
        assert.equal(tree.node("node_modules"), undefined);
        assert.equal(tree.node("node_modules/dep.js"), undefined);
        assert.notEqual(tree.node("visible.txt"), undefined);
        const withExclude: WorkspaceTree = new WorkspaceTree(root, { exclude: ["ignored.txt"] });
        assert.equal(withExclude.node("ignored.txt"), undefined);
        expectCode((): unknown => buildFileNode(root, "node_modules/dep.js"), "excluded_path");
        expectCode((): unknown => buildFileNode(root, "ignored.txt", { exclude: ["ignored.txt"] }), "excluded_path");
        if (linked) {
            assert.equal(tree.node("link.txt"), undefined);
        }
        const withHidden: WorkspaceTree = new WorkspaceTree(root, { includeHidden: true });
        assert.notEqual(withHidden.node(".hidden.txt"), undefined);
        assert.equal(withHidden.node("node_modules/dep.js"), undefined);
        if (linked) {
            const followed: WorkspaceTree = new WorkspaceTree(root, { followSymlinks: true });
            const linkedNode: FileNode = fileOf(followed, "link.txt");
            assert.equal(linkedNode.fingerprint, fileOf(followed, "target.txt").fingerprint);
        }
    } finally {
        cleanup(directory);
    }
});

test("maxNodes and maxBytes truncate instead of throwing", (): void => {
    const directory: string = fixture();
    try {
        write(directory, "a.txt", "aa");
        write(directory, "b.txt", "bb");
        write(directory, "c.txt", "cc");
        const root: SessionRoot = rootOf(directory);
        const nodes: TreeSnapshot = buildTree(root, { maxNodes: 2, timeZone: "utc" });
        assert.equal(nodes.stats.truncated, true);
        assert.equal(nodes.root.children.length, 1);
        assert.equal(nodes.stats.files, 1n);
        assert.equal(nodes.stats.directories, 1n);
        const bytes: TreeSnapshot = buildTree(root, { maxBytes: 3n, timeZone: "utc" });
        assert.equal(bytes.stats.truncated, true);
        assert.equal(bytes.root.bytes, 2n);
        assert.equal(bytes.stats.bytes, 2n);
        const full: TreeSnapshot = buildTree(root, { timeZone: "utc" });
        assert.equal(full.stats.truncated, false);
        assert.equal(full.stats.files, 3n);
    } finally {
        cleanup(directory);
    }
});

test("binary files report charset=binary and zero lines", (): void => {
    const directory: string = fixture();
    try {
        write(directory, "blob.bin", new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0xff]));
        const tree: WorkspaceTree = new WorkspaceTree(rootOf(directory));
        const file: FileNode = fileOf(tree, "blob.bin");
        assert.equal(file.charset, "binary");
        assert.equal(file.lines, 0n);
        assert.equal(file.bytes, 6n);
        assert.match(file.fingerprint, /^sha256:[0-9a-f]{64}$/);
    } finally {
        cleanup(directory);
    }
});

test("UTF-8 BOM files keep their charset and line count", (): void => {
    const directory: string = fixture();
    try {
        const body: Buffer = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("hello\nworld\n", "utf8")]);
        write(directory, "bom.txt", new Uint8Array(body));
        const tree: WorkspaceTree = new WorkspaceTree(rootOf(directory));
        const file: FileNode = fileOf(tree, "bom.txt");
        assert.equal(file.charset, "utf-8-bom");
        assert.equal(file.lines, 2n);
        assert.equal(file.bytes, 15n);
        assert.equal(file.description, "hello");
        assert.equal(file.summary, "hello world");
    } finally {
        cleanup(directory);
    }
});

test("deterministic metadata covers JSDoc, Markdown, package.json and front matter", (): void => {
    const directory: string = fixture();
    try {
        write(
            directory,
            "src/service.ts",
            "/**\n * Serve one request.\n *\n * Applies the policy and returns a result.\n * @purpose Handle HTTP requests.\n */\nexport const serve = 1;\n",
        );
        write(directory, "README.md", "# Project title\n\nA short project summary.\n\n## Details\nMore text.\n");
        write(directory, "package.json", JSON.stringify({ name: "demo", description: "A demo package." }));
        write(directory, "docs/guide.md", "---\ntitle: Guide\ndescription: Guide description.\npurpose: Explain the guide.\n---\n# Heading\n\nBody paragraph.\n");
        write(directory, "long.md", `# ${"T".repeat(300)}\n\n${"word ".repeat(100)}\n`);
        write(directory, "emoji.md", `# ${"😀".repeat(100)}\n\n${"😀".repeat(300)}\n`);
        write(directory, "huge/package.json", `{"name":"demo","description":"${"x".repeat(70 * 1024)}"}`);
        const tree: WorkspaceTree = new WorkspaceTree(rootOf(directory), { timeZone: "utc" });
        const service: FileNode = fileOf(tree, "src/service.ts");
        assert.equal(service.description, "Serve one request.");
        assert.equal(service.summary, "Serve one request. Applies the policy and returns a result.");
        assert.equal(service.purpose, "Handle HTTP requests.");
        const readme: FileNode = fileOf(tree, "README.md");
        assert.equal(readme.description, "Project title");
        assert.equal(readme.summary, "A short project summary.");
        const manifest: FileNode = fileOf(tree, "package.json");
        assert.equal(manifest.description, "Package demo.");
        assert.equal(manifest.summary, "A demo package.");
        assert.equal(manifest.purpose, "not declared");
        const guide: FileNode = fileOf(tree, "docs/guide.md");
        assert.equal(guide.description, "Guide");
        assert.equal(guide.summary, "Guide description.");
        assert.equal(guide.purpose, "Explain the guide.");
        const long: FileNode = fileOf(tree, "long.md");
        assert.ok(long.description.length <= 160);
        assert.ok(long.summary.length <= 400);
        assert.equal(long.purpose, "not declared");
        const emoji: FileNode = fileOf(tree, "emoji.md");
        assert.ok(emoji.description.length <= 160);
        assert.ok(emoji.summary.length <= 400);
        assert.equal(wellFormed(emoji.description), true);
        assert.equal(wellFormed(emoji.summary), true);
        const hugePackage: FileNode = fileOf(tree, "huge/package.json");
        assert.equal(hugePackage.description, "File package.json.");
        assert.equal(hugePackage.summary, "File package.json.");
        assert.equal(hugePackage.purpose, "not declared");
    } finally {
        cleanup(directory);
    }
});

test("directory listings are ordered, paged and shallow", (): void => {
    const directory: string = fixture();
    try {
        mkdirSync(join(directory, "adir"));
        mkdirSync(join(directory, "bdir"));
        write(directory, "a.txt", "a\n");
        write(directory, "b.txt", "b\n");
        const tree: WorkspaceTree = new WorkspaceTree(rootOf(directory));
        const first: DirectoryListing = listDirectory(tree, ".", 0, 2);
        assert.equal(first.total, 4);
        assert.equal(first.nextOffset, 2);
        assert.deepEqual(
            first.entries.map((entry: WireTreeNode): string => entry.name),
            ["adir", "bdir"],
        );
        assert.equal(first.entries[0].type, "Directory");
        assert.equal(first.entries[0].children.length, 0);
        const second: DirectoryListing = listDirectory(tree, ".", 2, 2);
        assert.deepEqual(
            second.entries.map((entry: WireTreeNode): string => entry.name),
            ["a.txt", "b.txt"],
        );
        assert.equal(second.nextOffset, null);
        const clamped: DirectoryListing = listDirectory(tree, ".", 0, 1000);
        assert.equal(clamped.entries.length, 4);
        expectCode((): unknown => listDirectory(tree, "a.txt"), "not_directory");
        expectCode((): unknown => listDirectory(tree, "missing"), "not_found");
    } finally {
        cleanup(directory);
    }
});

test("verifyFingerprint accepts the current digest and rejects a mismatch", (): void => {
    const directory: string = fixture();
    try {
        write(directory, "a.txt", "content\n");
        const root: SessionRoot = rootOf(directory);
        const node: FileNode = buildFileNode(root, "a.txt");
        assert.doesNotThrow((): void => verifyFingerprint(root, "a.txt", node.fingerprint));
        expectCode((): void => verifyFingerprint(root, "a.txt", `sha256:${"0".repeat(64)}`), "fingerprint_mismatch");
        const tree: WorkspaceTree = new WorkspaceTree(root);
        assert.equal(tree.snapshot().root.path, ".");
    } finally {
        cleanup(directory);
    }
});
