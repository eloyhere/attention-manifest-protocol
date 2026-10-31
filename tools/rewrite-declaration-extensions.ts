#!/usr/bin/env node
/**
 * Rewrite TypeScript extensions in emitted declarations to JavaScript ones.
 *
 * `tsc` rewrites relative `.ts` specifiers when it emits `.js`, but leaves them
 * untouched in `.d.ts`. A published declaration importing `./frame.ts` would
 * therefore point at a file that only exists as `./frame.js`, so consumers
 * would fail to resolve the types.
 */
import { existsSync } from "node:fs";
import type { Dirent } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Declaration root produced by `tsconfig.build.json`.
 */
const Root: string = path.resolve(import.meta.dirname, "..", "lib");

/**
 * Relative specifier ending in a TypeScript extension, quoted either way.
 */
const Specifier: RegExp = /(["'])(\.{1,2}\/[^"']*?)\.(ts|tsx|mts|cts)\1/g;

/**
 * Emitted JavaScript extension for each TypeScript extension.
 */
const Emitted: Record<string, string> = { ts: ".js", tsx: ".jsx", mts: ".mjs", cts: ".cjs" };

/**
 * Declaration files discovered under {@link Root}.
 */
const Declarations: string[] = [];

/**
 * Collect `.d.ts` files under one directory tree.
 *
 * @param directory Absolute directory to walk.
 */
const collect: (directory: string) => Promise<void> = async (directory: string): Promise<void> => {
    const entries: Dirent[] = await readdir(directory, { withFileTypes: true });
    for (let index: number = 0; index < entries.length; index += 1) {
        const entry: Dirent = entries[index];
        const full: string = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            await collect(full);
        } else if (entry.name.endsWith(".d.ts")) {
            Declarations.push(full);
        }
    }
};

/**
 * Replace TypeScript specifier extensions inside one declaration file.
 *
 * @param file Absolute path to a declaration file.
 * @returns Whether the file changed.
 */
const rewrite: (file: string) => Promise<boolean> = async (file: string): Promise<boolean> => {
    const before: string = await readFile(file, "utf8");
    const after: string = before.replace(
        Specifier,
        (match: string, quote: string, base: string, extension: string): string => `${quote}${base}${Emitted[extension]}${quote}`,
    );
    if (after === before) {
        return false;
    }
    await writeFile(file, after, "utf8");
    return true;
};

if (!existsSync(Root)) {
    throw new Error(`missing declaration output: ${Root} (run tsc -p tsconfig.build.json first)`);
}

await collect(Root);

let Rewrites: number = 0;
for (let index: number = 0; index < Declarations.length; index += 1) {
    if (await rewrite(Declarations[index])) {
        Rewrites += 1;
    }
}

const Leftovers: string[] = [];
for (let index: number = 0; index < Declarations.length; index += 1) {
    const file: string = Declarations[index];
    if (Specifier.test(await readFile(file, "utf8"))) {
        Leftovers.push(file);
    }
    Specifier.lastIndex = 0;
}

if (Leftovers.length > 0) {
    throw new Error(`declarations still reference TypeScript extensions: ${Leftovers.join(", ")}`);
}

console.log(`rewrote ${Rewrites} of ${Declarations.length} declaration files under ${path.relative(process.cwd(), Root)}`);
