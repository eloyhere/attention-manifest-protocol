#!/usr/bin/env node
/**
 * Read-only repository inspection and explicit candidate-to-Frame demo.
 * Git supplies the file inventory; local sources are parsed, never executed.
 */
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

import { MemoryContentStore } from "../src/context/contentStore.ts";
import { readDocumentDetail } from "../src/context/document.ts";
import { WorkspaceIndex } from "../src/context/workspace.ts";
import type { WorkspaceDiagnostic, WorkspaceEntity, WorkspaceQueryResult, WorkspaceSnapshot } from "../src/context/workspace.ts";
import type { Context } from "../src/context/lifecycle.ts";
import type { Frame } from "../src/frame/frame.ts";
import { scanStructuredWorkspace } from "./support/documentScanner.ts";
import type { StructuredWorkspaceFile } from "./support/documentScanner.ts";

const Args: string[] = process.argv.slice(2);
let QueryText: string = "";
let Limit: number = 6;
let Tokens: number = 2500;
const Seeds: string[] = [];
const Projects: string[] = [];
const Reads: string[] = [];
for (let argumentIndex: number = 0; argumentIndex < Args.length; argumentIndex += 2) {
    const flag: string = Args[argumentIndex];
    const value: string | undefined = Args[argumentIndex + 1];
    if (value === (void 0) || !["--query", "--seed", "--limit", "--tokens", "--project", "--read"].includes(flag)) {
        throw new Error(
            "usage: node tools/workspace-context.ts [--query text] [--seed path-or-id] [--project id] [--limit 1..9] [--tokens positive-integer] [--read node-id]",
        );
    }
    if (flag === "--query") {
        QueryText = value;
    } else if (flag === "--seed") {
        Seeds.push(/^(?:file|symbol|project|directory|knowledge|package):/.test(value) ? value : `file:${value.replace(/\\/g, "/")}`);
    } else if (flag === "--project") {
        Projects.push(value);
    } else if (flag === "--read") {
        Reads.push(value);
    } else if (flag === "--limit") {
        Limit = Number(value);
    } else {
        Tokens = Number(value);
    }
}
if (!Number.isSafeInteger(Limit) || Limit < 1 || Limit > 9 || !Number.isSafeInteger(Tokens) || Tokens < 1) {
    throw new RangeError("limit must be 1..9 and tokens a positive safe integer");
}
const Root: string = realpathSync(process.cwd());
const Inventory: string[] = [
    ...new Set(
        execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: Root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })
            .split("\0")
            .filter(Boolean),
    ),
].sort();
const Files: StructuredWorkspaceFile[] = [];
const Skipped: WorkspaceDiagnostic[] = [];
Inventory.forEach((path: string): void => {
    if (
        path.split("/").some((part: string): boolean => part.startsWith(".") || ["node_modules", "dist", "vendor", "coverage"].includes(part)) ||
        path.startsWith("docs/probes/")
    ) {
        return;
    }
    if (
        !/\.(?:[cm]?[jt]sx?|md|txt|tex|ltx|sty|cls|bib|docx|xlsx|pptx|pdf|epub|doc|xls|ppt|png|jpe?g|eps|svg|webp)$/i.test(path) &&
        !/(?:^|\/)(?:package|tsconfig[^/]*)\.json$/.test(path)
    ) {
        return;
    }
    try {
        const absolute: string = resolve(Root, path);
        const resolved: string = realpathSync(absolute);
        const local: string = relative(Root, resolved);
        const stat: ReturnType<typeof lstatSync> = lstatSync(absolute);
        if (isAbsolute(local) || local === ".." || local.startsWith("..\\") || local.startsWith("../") || stat.isSymbolicLink() || !stat.isFile()) {
            Skipped.push({ uri: path, code: "skipped_path", message: "not an ordinary file within the selected repository" });
        } else if (stat.size > (/\.(?:docx|xlsx|pptx|png|jpe?g|eps|svg|webp)$/i.test(path) ? 16 * 1024 * 1024 : 256 * 1024) || Files.length >= 5000) {
            Skipped.push({ uri: path, code: "scan_limit", message: "256 KiB text / 16 MiB modern Office or image per-file or 5000-file scan limit" });
        } else {
            Files.push({ path, content: /\.(?:[cm]?[jt]sx?|md|txt|json)$/i.test(path) ? readFileSync(absolute, "utf8") : readFileSync(absolute) });
        }
    } catch {
        Skipped.push({ uri: path, code: "unreadable_file", message: "file was removed or could not be read" });
    }
});
const Store: MemoryContentStore = new MemoryContentStore();
const Snapshot: WorkspaceSnapshot = scanStructuredWorkspace(Files, Store);
Snapshot.diagnostics.push(...Skipped);
const Index: WorkspaceIndex = new WorkspaceIndex(Snapshot, Store);
const Found: WorkspaceQueryResult = Index.query({
    seedIds: Seeds,
    text: QueryText,
    limit: Limit,
    maxDepth: 1,
    ...(Projects.length > 0 ? { projectIds: Projects } : {}),
});
const Frame: Frame = {
    amp: "0.1",
    kind: "frame",
    id: "f.workspace.demo",
    agent: "a.workspace.demo",
    cycle: 1,
    ts: new Date().toISOString(),
    digest: Snapshot.revision,
    mode: "explore",
    slots: Found.candidates.map((candidate): Frame["slots"][number] => ({
        target: { kind: "other", id: candidate.id },
        role: "artifact",
        salience: 1,
        cost: {},
        why: `workspace demo explicitly allocates ${candidate.why}`,
        state: "active",
    })),
    budget: { allocated: { tokens: Tokens }, spent: {} },
};
const Materialized: Context = Index.context(Frame, Tokens);
const Count: Record<string, number> = {};
Snapshot.entities.forEach((entity: WorkspaceEntity): void => {
    Count[entity.kind] = (Count[entity.kind] ?? 0) + 1;
});
const DiagnosticCounts: Record<string, number> = {};
Snapshot.diagnostics.forEach((item: WorkspaceDiagnostic): void => {
    DiagnosticCounts[item.code] = (DiagnosticCounts[item.code] ?? 0) + 1;
});
process.stdout.write(
    `${JSON.stringify({ revision: Snapshot.revision, files: Files.length, entities: Count, relations: Snapshot.relations.length, diagnostics: DiagnosticCounts, query: Found, view: Materialized.view, details: Reads.map((id: string) => ({ id, detail: readDocumentDetail(Materialized, id) ?? null })) }, null, 2)}\n`,
);
