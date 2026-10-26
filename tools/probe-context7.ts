#!/usr/bin/env node
/**
 * Focused probe: context7's 2026-07-28 header contract.
 */
const Endpoint: string = "https://mcp.context7.com/mcp";

const parseSse: (text: string) => unknown = (text: string): unknown => {
    const joined: string = text
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
        .join("");
    return JSON.parse(joined);
};

type RpcResult = {
    status: number;
    body: unknown;
};

type Rpc = (method: string, params: Record<string, unknown>, extra?: Record<string, string>) => Promise<RpcResult>;

const rpc: Rpc = async (method: string, params: Record<string, unknown>, extra: Record<string, string> = {}): Promise<RpcResult> => {
    const res: Response = await fetch(Endpoint, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "mcp-protocol-version": "2026-07-28",
            "mcp-method": method,
            ...extra,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
        signal: AbortSignal.timeout(15_000),
    });
    const text: string = await res.text();
    const type: string = res.headers.get("content-type") ?? "";
    let body: unknown;
    try {
        body = type.includes("text/event-stream") ? parseSse(text) : JSON.parse(text);
    } catch {
        body = { raw: text.slice(0, 300) };
    }
    return { status: res.status, body };
};

const Meta: Record<string, unknown> = {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientCapabilities": {},
};

const Discover: RpcResult = await rpc("server/discover", { _meta: Meta });
console.log("discover:", Discover.status, JSON.stringify(Discover.body).slice(0, 400));

const List: RpcResult = await rpc("tools/list", { _meta: Meta });
console.log("list:", List.status, JSON.stringify(List.body).slice(0, 300));

const Call: RpcResult = await rpc(
    "tools/call",
    { name: "resolve-library-id", arguments: { query: "how to use hooks", libraryName: "react" }, _meta: Meta },
    { "mcp-name": "resolve-library-id" },
);
console.log("call:", Call.status, JSON.stringify(Call.body).slice(0, 700));
