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

const walk: (dir: string) => string[] = (dir: string): string[] => {
    const files: string[] = [];
    const names: string[] = readdirSync(dir);
    for (let index: number = 0; index < names.length; index += 1) {
        const name: string = names[index];
        const path: string = join(dir, name);
        if (statSync(path).isDirectory()) {
            files.push(...walk(path));
        } else if (path.endsWith(".ts")) {
            files.push(path);
        }
    }
    return files;
};

const RuntimeFiles: string[] = walk("src/runtime");
const RuntimeText: string = RuntimeFiles.map((file) => readFileSync(file, "utf8")).join("\n");
assert.equal(/from\s+["'][^"']*database/.test(RuntimeText), false, "runtime must not import database");
assert.equal(/node:sqlite/.test(RuntimeText), false, "runtime must not import node:sqlite");

const Kernel: string = readFileSync("src/kernel/scheduler.ts", "utf8");
assert.equal(/\bdb\.prepare\(/.test(Kernel), false, "kernel must use the execution port, not raw SQL");

const ProcessSqlBaseline: number = 0;
const ProcessSql: number =
    ["src/process/process.ts", "src/thread/thread.ts"]
        .map((file) => readFileSync(file, "utf8"))
        .join("\n")
        .match(/\.prepare\(/g)?.length ?? 0;
assert.ok(ProcessSql <= ProcessSqlBaseline, `process/thread raw SQL grew to ${ProcessSql} (baseline ${ProcessSqlBaseline})`);

const RuntimeIndex: string = readFileSync("src/runtime/index.ts", "utf8");
assert.equal(RuntimeIndex.includes("database"), false, "runtime index must not re-export database");

const LegacyUsers: string[] = readdirSync("tools")
    .filter((name) => name.endsWith(".ts") && name !== "arch-check.ts")
    .filter((name) => readFileSync(join("tools", name), "utf8").includes("support/ampRuntime"))
    .sort();
assert.deepEqual(LegacyUsers, [], `legacy AmpRuntime references must be gone, found: ${LegacyUsers.join(", ")}`);

console.log(
    `\x1b[32m✓\x1b[0m architecture fitness: runtime database-free, kernel SQL-free, process/thread SQL=${ProcessSql}<=${ProcessSqlBaseline}, legacy runtime deleted`,
);
console.log("\n1 passed, 0 failed");
