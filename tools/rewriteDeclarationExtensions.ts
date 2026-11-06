import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../lib/", import.meta.url));
for (const item of readdirSync(root, { recursive: true })) {
    if (!item.endsWith(".d.ts")) { continue; }
    const path = join(root, item);
    const original = readFileSync(path, "utf8");
    const rewritten = original.replace(/(["'])(\.{1,2}\/[^"'\r\n]+)\.ts\1/g, "$1$2.js$1");
    if (rewritten !== original) { writeFileSync(path, rewritten, "utf8"); }
}
