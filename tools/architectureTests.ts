import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root: string = fileURLToPath(new URL("../src/", import.meta.url));
const tests: string[] = readdirSync(root, { recursive: true })
    .filter((entry: string | Buffer): entry is string => typeof(entry) === "string" && entry.endsWith(".test.ts"))
    .map((entry: string): string => join(root, entry))
    .sort();
if (tests.length === 0) {
    throw new Error("No architecture tests found");
}
const result = spawnSync(process.execPath, ["--test", ...tests], { stdio: "inherit" });
if (result.error !== (void 0)) {
    throw result.error;
}
process.exitCode = result.status ?? 1;
