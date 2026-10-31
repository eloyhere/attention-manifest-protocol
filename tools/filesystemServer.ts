#!/usr/bin/env node
/**
 * Filesystem MCP server over newline-delimited JSON-RPC on stdio.
 *
 * The host bootstrap supplies the SQLite path (optional) and either an existing
 * session credential or a root set to open one. The bearer token is read from
 * the host file, never from argv or an environment echo, and it never appears in
 * a tool response.
 */
import { readFileSync, statSync } from "node:fs";
import { openStore } from "../src/database/store/database.ts";
import { SqliteFilesystemStore } from "../src/database/adapter/filesystemStore.ts";
import { SqliteWorkspaceSessionContextStore, SqliteWorkspaceSessionStore } from "../src/database/adapter/workspaceSessionStore.ts";
import type { FilesystemServiceLimits } from "../src/file/service.ts";
import { FilesystemService } from "../src/file/service.ts";
import type { AnnotationMap } from "../src/file/runtime.ts";
import { FilesystemMcpServer } from "../src/module/mcp/filesystemServer.ts";
import { SessionRegistry } from "../src/session/registry.ts";
import type { SessionCredential, SessionRoot } from "../src/session/types.ts";

interface Bootstrap {
    version: 1;
    database?: string;
    sessionId?: string;
    token?: string;
    agentId?: string;
    roots?: SessionRoot[];
    limits?: Partial<FilesystemServiceLimits>;
    annotations?: AnnotationMap;
}

const MaxInputBytes: number = 1024 * 1024;
const Args: string[] = process.argv.slice(2);
const emit: (response: unknown) => void = (response: unknown): void => {
    process.stdout.write(`${JSON.stringify(response)}\n`);
};

try {
    if (Args.length !== 2 || Args[0] !== "--config" || statSync(Args[1]).size > 8 * 1024 * 1024) {
        throw new Error("usage: node tools/filesystemServer.ts --config host-bootstrap.json (max 8 MiB)");
    }
    const config: Bootstrap = JSON.parse(readFileSync(Args[1], "utf8")) as Bootstrap;
    if (config.version !== 1) {
        throw new Error("invalid host bootstrap");
    }
    const db = config.database === (void 0) ? (void 0) : openStore(config.database);
    const registry: SessionRegistry = new SessionRegistry({
        ...(db === (void 0)
            ? {}
            : {
                  store: new SqliteWorkspaceSessionStore(db),
                  contextStore: new SqliteWorkspaceSessionContextStore(db),
              }),
    });
    let credential: SessionCredential;
    if (typeof(config.sessionId) === "string" && typeof(config.token) === "string") {
        credential = { sessionId: config.sessionId, token: config.token };
    } else if (typeof(config.agentId) === "string" && Array.isArray(config.roots) && config.roots.length > 0) {
        credential = registry.open({ agentId: config.agentId, roots: config.roots }).credential;
    } else {
        throw new Error("bootstrap requires sessionId+token or agentId+roots");
    }
    const service: FilesystemService = new FilesystemService({
        registry,
        ...(db === (void 0) ? {} : { store: new SqliteFilesystemStore(db) }),
        ...(config.annotations === (void 0) ? {} : { annotations: config.annotations }),
        ...(config.limits === (void 0) ? {} : { limits: config.limits }),
    });
    const session = service.bind(credential.sessionId, credential.token);
    const server: FilesystemMcpServer = new FilesystemMcpServer(session);
    let pending: Buffer = Buffer.alloc(0);
    let dropping: boolean = false;
    let queue: Promise<void> = Promise.resolve();
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
        queue = queue.then(async (): Promise<void> => {
            const response = await server.handle(parsed);
            if (response !== (void 0)) {
                emit(response);
            }
        });
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
        queue.then((): void => {
            if (db !== (void 0)) {
                db.close();
            }
        });
    });
} catch (error: unknown) {
    process.stderr.write(`${error instanceof Error ? error.message : "filesystem server startup failed"}\n`);
    process.exitCode = 1;
}
