#!/usr/bin/env node
/**
 * MCP newline-delimited JSON-RPC over stdio. Only the host-provided bootstrap
 * file is opened. No filesystem path, scan or Frame registration tool exists.
 */
import { readFileSync, statSync } from "node:fs";
import { MemoryContentStore } from "../src/context/contentStore.ts";
import type { WorkspaceSnapshot } from "../src/context/workspace.ts";
import { WorkspaceAgentService } from "../src/context/workspaceService.ts";
import type { WorkspaceServiceLimits } from "../src/context/workspaceService.ts";
import type { Frame } from "../src/frame/frame.ts";
import { WorkspaceMcpServer } from "../src/module/mcp/workspaceServer.ts";
import type { WorkspaceRpcResponse } from "../src/module/mcp/workspaceServer.ts";

interface Bootstrap {
    version: 1;
    agentId: string;
    projectIds: string[];
    snapshot: WorkspaceSnapshot;
    contents: Record<string, string>;
    frames: Frame[];
    limits?: Partial<WorkspaceServiceLimits>;
}

const MaxInputBytes: number = 1024 * 1024;
const Args: string[] = process.argv.slice(2);
const emit: (response: WorkspaceRpcResponse) => void = (response: WorkspaceRpcResponse): void => {
    process.stdout.write(`${JSON.stringify(response)}\n`);
};

try {
    if (Args.length !== 2 || Args[0] !== "--config" || statSync(Args[1]).size > 64 * 1024 * 1024) {
        throw new Error("usage: node tools/workspace-agent-server.ts --config host-bootstrap.json (max 64 MiB)");
    }
    const config: Bootstrap = JSON.parse(readFileSync(Args[1], "utf8")) as Bootstrap;
    if (config.version !== 1 || !config.contents || !Array.isArray(config.frames)) {
        throw new Error("invalid host bootstrap");
    }
    const store: MemoryContentStore = new MemoryContentStore();
    Object.entries(config.contents).forEach(([ref, content]: [string, string]): void => {
        if (typeof(content) !== "string" || store.put(content) !== ref) {
            throw new Error("bootstrap content integrity mismatch");
        }
    });
    const service: WorkspaceAgentService = new WorkspaceAgentService({ ...config, store });
    config.frames.forEach((frame: Frame): void => {
        service.registerFrame(frame, config.snapshot.revision);
    });
    const server: WorkspaceMcpServer = new WorkspaceMcpServer(service);
    let pending: Buffer = Buffer.alloc(0);
    let dropping: boolean = false;
    const consume: (line: Buffer) => void = (line: Buffer): void => {
        if (line.length === 0 || line.toString("utf8").trim() === "") {
            return;
        }
        let parsed: unknown;
        try {
            parsed = JSON.parse(line.toString("utf8"));
        } catch {
            emit({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
            return;
        }
        const response: WorkspaceRpcResponse | undefined = server.handle(parsed);
        if (response !== (void 0)) {
            emit(response);
        }
    };
    process.stdin.on("data", (chunk: Buffer): void => {
        let start: number = 0;
        while (start < chunk.length) {
            const newline: number = chunk.indexOf(10, start);
            const end: number = newline < 0 ? chunk.length : newline;
            const part: Buffer = chunk.subarray(start, end);
            if (!dropping && pending.length + part.length > MaxInputBytes) {
                dropping = true;
                pending = Buffer.alloc(0);
                emit({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "request exceeds 1 MiB" } });
            }
            if (!dropping) {
                pending = Buffer.concat([pending, part]);
            }
            if (newline < 0) {
                break;
            }
            if (!dropping) {
                consume(pending);
            }
            pending = Buffer.alloc(0);
            dropping = false;
            start = newline + 1;
        }
    });
    process.stdin.on("end", (): void => {
        if (!dropping && pending.length > 0) {
            consume(pending);
        }
    });
} catch (error: unknown) {
    process.stderr.write(`${error instanceof Error ? error.message : "workspace server startup failed"}\n`);
    process.exitCode = 1;
}
