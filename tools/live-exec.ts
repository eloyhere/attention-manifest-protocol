#!/usr/bin/env node
/**
 * LIVE end-to-end test against a real 2026-07-28 MCP server (context7).
 *
 * This is an integration probe, not part of the offline test suite: it needs
 * network and the endpoint may change its policy at any time. Run manually:
 *   node tools/live-exec.ts
 */
import { ExecProfile } from "../src/execution/exec.ts";
import { HandleStore } from "../src/execution/handles.ts";
import { HttpTransport } from "../src/module/mcp/http.ts";
import { McpClient } from "../src/module/mcp/client.ts";

const URL_ = process.env.MCP_URL ?? "https://mcp.context7.com/mcp";

const transport = new HttpTransport({ url: URL_, protocolVersion: "2026-07-28" });
const client = new McpClient(transport, "amp-live");
const handles = new HandleStore();

let tick = 0;
const now = () => new Date(Date.UTC(2026, 9, 24, 2, 0, tick++)).toISOString();

const receipts = [];
const exec = new ExecProfile(client, {
    budget: { calls: 5, ms: 60_000 },
    handles,
    now,
    maxResultTokens: 300,
    requireApproval: true,
    onReceipt: (receipt) => receipts.push(receipt),
});

console.log(`endpoint: ${URL_}`);

const discovery = await client.discover();
console.log(`discover: versions=${discovery.supportedVersions.join(",")}  ttlMs=${discovery.ttlMs}`);

const snapshot = await exec.connect();
console.log(`tools: ${snapshot.tools.length}  digest=${snapshot.digest.slice(0, 20)}…`);
for (const tool of snapshot.tools) {
    console.log(`  - ${tool.name}`);
}

const out = await exec.call(
    "resolve-library-id",
    { query: "how to use hooks", libraryName: "react" },
    { effect: "read", budgetTokens: 300, predictedVoi: 0.6, realizedVoi: 0.55 },
);

console.log(`\ncall: outcome=${out.receipt.outcome}  tokens=${out.tokens}  handle=${out.handle ?? "inline"}`);
console.log(`usage: ${JSON.stringify(out.receipt.usage)}`);
console.log(`receipt: ${JSON.stringify(out.receipt)}`);

if (out.handle) {
    const page = handles.read(out.handle, 0, 120);
    console.log(`\nfirst page (${page.tokens} tokens, next=${page.next}):`);
    console.log(page.text.slice(0, 400));
} else {
    console.log(`\ninline:\n${(out.inline ?? "").slice(0, 400)}`);
}

console.log(`\nreceipts: ${receipts.length}`);
