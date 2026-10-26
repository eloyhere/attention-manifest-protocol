#!/usr/bin/env node
/**
 * Architecture fitness checks. These are intentionally cheap textual guards;
 * they fail the verify when a dependency rule regresses.
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

assert.equal(existsSync("src/cycle"), false, "legacy cycle directory must stay deleted");
assert.equal(existsSync("tools/support/ampRuntime.ts"), false, "legacy AmpRuntime fixture must stay deleted");

const walk = (dir: string): string[] => {
    const files: string[] = [];
    for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) files.push(...walk(path));
        else if (path.endsWith(".ts")) files.push(path);
    }
    return files;
};

const runtimeFiles = walk("src/runtime");
const runtimeText = runtimeFiles.map((file) => readFileSync(file, "utf8")).join("\n");
assert.equal(/from\s+["'][^"']*database/.test(runtimeText), false, "runtime must not import database");
assert.equal(/node:sqlite/.test(runtimeText), false, "runtime must not import node:sqlite");

const kernel = readFileSync("src/kernel/scheduler.ts", "utf8");
assert.equal(/\bdb\.prepare\(/.test(kernel), false, "kernel must use the execution port, not raw SQL");

const processSqlBaseline = 0;
const processSql =
    ["src/process/process.ts", "src/thread/thread.ts"]
        .map((file) => readFileSync(file, "utf8"))
        .join("\n")
        .match(/\.prepare\(/g)?.length ?? 0;
assert.ok(processSql <= processSqlBaseline, `process/thread raw SQL grew to ${processSql} (baseline ${processSqlBaseline})`);

const runtimeIndex = readFileSync("src/runtime/index.ts", "utf8");
assert.equal(runtimeIndex.includes("database"), false, "runtime index must not re-export database");

const legacyUsers = readdirSync("tools")
    .filter((name) => name.endsWith(".ts") && name !== "arch-check.ts")
    .filter((name) => readFileSync(join("tools", name), "utf8").includes("support/ampRuntime"))
    .sort();
assert.deepEqual(legacyUsers, [], `legacy AmpRuntime references must be gone, found: ${legacyUsers.join(", ")}`);

console.log(
    `\x1b[32m✓\x1b[0m architecture fitness: runtime database-free, kernel SQL-free, process/thread SQL=${processSql}<=${processSqlBaseline}, legacy runtime deleted`,
);
console.log("\n1 passed, 0 failed");
