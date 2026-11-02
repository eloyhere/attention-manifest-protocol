#!/usr/bin/env node
/** Compatibility stdio entry point; uses the same ordered async host bootstrap. */
import { runWorkspaceServer } from "./workspaceServerHost.ts";

await runWorkspaceServer(process.argv.slice(2));
