/**
 * Content digest for a module directory.
 *
 * A declaration that only records a path proves almost nothing. This module
 * hashes every file under the directory into a sorted manifest, then hashes the
 * manifest, so a declaration can bind the actual code. `verifyModuleContent`
 * recomputes it and reports drift.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { digestOf } from "../semantic/canonical.ts";
import { sha256Hex } from "../semantic/sha256.ts";

export interface ContentEntry {
    path: string;
    digest: string;
}

const Skip = new Set<string>(["node_modules", ".git", ".tscheck", "dist"]);

const walk = async (root: string, current: string, out: ContentEntry[]): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
        if (Skip.has(entry.name)) {
            continue;
        }
        const full: string = path.join(current, entry.name);
        if (entry.isDirectory()) {
            await walk(root, full, out);
            continue;
        }
        if (!entry.isFile()) {
            continue;
        }
        const text: string = await readFile(full, "utf8");
        out.push({ path: path.relative(root, full).split(path.sep).join("/"), digest: sha256Hex(text) });
    }
};

export const collectDirectory = async (root: string): Promise<ContentEntry[]> => {
    const entries: ContentEntry[] = [];
    await walk(root, root, entries);
    return entries;
};

/**
 * Deterministic digest of a directory's current content.
 */
export const digestDirectory = async (root: string): Promise<string> => {
    return digestOf(await collectDirectory(root));
};

export const diffDirectory = async (root: string, expected: readonly ContentEntry[]): Promise<ContentEntry[]> => {
    const actual: ContentEntry[] = await collectDirectory(root);
    const expectedMap = new Map(expected.map((entry) => [entry.path, entry.digest]));
    const changed: ContentEntry[] = [];
    for (const entry of actual) {
        if (expectedMap.get(entry.path) !== entry.digest) {
            changed.push(entry);
        }
        expectedMap.delete(entry.path);
    }
    for (const [missingPath, digest] of expectedMap) {
        changed.push({ path: missingPath, digest });
    }
    return changed;
};
