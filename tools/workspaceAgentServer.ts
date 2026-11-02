#!/usr/bin/env node
/** MCP newline-delimited JSON-RPC; bootstrap owns the SQLite catalog and ES index. */
import { runWorkspaceServer } from "./workspaceServerHost.ts";

await runWorkspaceServer(process.argv.slice(2));
