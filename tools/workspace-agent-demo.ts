#!/usr/bin/env node
/**
 * Generate an immediately runnable host bootstrap from explicit demo inputs.
 * Real hosts use their authorized file inventory and Frame selection instead.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { MemoryContentStore } from "../src/context/contentStore.ts";
import type { WorkspaceSnapshot } from "../src/context/workspace.ts";
import type { Frame } from "../src/frame/frame.ts";
import { digestOf } from "../src/semantic/canonical.ts";
import { scanStructuredWorkspace } from "./support/documentScanner.ts";

const Store: MemoryContentStore = new MemoryContentStore();
const Snapshot: WorkspaceSnapshot = scanStructuredWorkspace(
    [
        { path: "package.json", content: '{"name":"amp-agent-demo"}' },
        { path: "main.ts", content: 'export const welcome = "AMP workspace service";' },
        {
            path: "guide.md",
            content: "# Agent guide\nDiscover capabilities, query candidates, materialize a registered Frame, then read detail.\n[Implementation](main.ts)",
        },
        {
            path: "paper.tex",
            content:
                "\\documentclass{article}\n\\begin{document}\n\\section{Structured context}\nA summary points to verifiable source detail.\n\\end{document}",
        },
    ],
    Store,
);
const FrameBody: Omit<Frame, "digest"> = {
    amp: "0.1",
    kind: "frame",
    id: "f.workspace.demo",
    agent: "a.workspace.demo",
    cycle: 0,
    ts: new Date().toISOString(),
    mode: "explore",
    slots: ["knowledge:guide.md#L1", "file:main.ts", "file:paper.tex"].map((id: string): Frame["slots"][number] => ({
        target: { kind: "other", id },
        role: "artifact",
        salience: 1,
        cost: {},
        why: "demo host explicitly allocated this document",
        state: "active",
    })),
    budget: { allocated: { tokens: 4000 }, spent: {} },
};
const Frame: Frame = { ...FrameBody, digest: digestOf(FrameBody) };
const Contents: Record<string, string> = Object.fromEntries(
    Snapshot.entities
        .filter((entity): boolean => entity.detailRef !== (void 0))
        .map((entity): [string, string] => [entity.detailRef!, Store.get(entity.detailRef!)!]),
);
const Output: string = resolve(".cache/workspace-agent.local");
mkdirSync(dirname(Output), { recursive: true });
writeFileSync(
    Output,
    `${JSON.stringify({ version: 1, agentId: Frame.agent, projectIds: ["project:."], snapshot: Snapshot, contents: Contents, frames: [Frame] }, null, 2)}\n`,
);
console.log(`Demo bootstrap: ${Output}`);
console.log("Run: npm run workspace-agent -- --config .cache/workspace-agent.local");
