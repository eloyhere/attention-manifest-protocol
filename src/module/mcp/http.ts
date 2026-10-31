import type { JsonRpcRequest, JsonRpcResponse } from "./protocol.ts";
import type { Transport } from "./transport.ts";

export interface HttpTransportOptions {
    url: string;
    /**
     * 2026-07-28 servers reject bodies whose envelope disagrees with the headers.
     */
    protocolVersion?: string;
    sessionId?: string;
    headers?: Record<string, string>;
    timeoutMs?: number;
}

const parseSse: (text: string, expectedId: number | undefined) => JsonRpcResponse = (text: string, expectedId: number | undefined): JsonRpcResponse => {
    const events: string[] = text.split(/\r?\n(?:\r?\n)+/);
    const responses: JsonRpcResponse[] = [];
    for (const event of events) {
        const data: string = event
            .split(/\r?\n/)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).replace(/^ /, ""))
            .join("\n");
        if (data.length === 0 || data === "[DONE]") {
            continue;
        }
        const payload: unknown = JSON.parse(data);
        if (typeof(payload) === "object" && payload !== null && !Array.isArray(payload) && "id" in payload && payload.id === expectedId) {
            responses.push(payload as JsonRpcResponse);
        }
    }
    if (responses.length !== 1) {
        throw new Error(responses.length === 0 ? "SSE response has no matching JSON-RPC event" : "SSE response has multiple matching JSON-RPC events");
    }
    return responses[0];
};

/**
 * Streamable-HTTP transport.
 *
 * The 2026-07-28 binding mirrors the JSON-RPC envelope into headers:
 * `MCP-Protocol-Version`, `Mcp-Method`, and `Mcp-Name` for tools/call.
 * Omitting them is what a real server (context7) reports as -32020.
 */
export class HttpTransport implements Transport {
    readonly url: string;
    /**
     * Mutable: legacy handshakes need 2025-06-18 before the version is negotiated.
     */
    protocolVersion: string;
    readonly extraHeaders: Record<string, string>;
    readonly timeoutMs: number;
    sessionId?: string;
    sent = 0;

    constructor(options: HttpTransportOptions) {
        this.url = options.url;
        this.protocolVersion = options.protocolVersion ?? "2026-07-28";
        this.sessionId = options.sessionId;
        this.extraHeaders = Object.fromEntries(Object.entries(options.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]));
        this.timeoutMs = options.timeoutMs ?? 20_000;
    }

    async send(request: JsonRpcRequest): Promise<JsonRpcResponse> {
        this.sent += 1;
        const headers: Record<string, string> = {
            ...this.extraHeaders,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "mcp-protocol-version": this.protocolVersion,
            "mcp-method": request.method,
        };
        if (this.sessionId) {
            headers["mcp-session-id"] = this.sessionId;
        }
        const toolName: unknown = request.params?.name;
        if (request.method === "tools/call" && typeof(toolName) === "string") {
            headers["mcp-name"] = toolName;
        }

        const controller: AbortController = new AbortController();
        const timer: ReturnType<typeof setTimeout> = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
            const response: Response = await fetch(this.url, {
                method: "POST",
                headers,
                body: JSON.stringify(request),
                signal: controller.signal,
            });
            const session: string | null = response.headers.get("mcp-session-id");
            if (session) {
                this.sessionId = session;
            }

            const text: string = await response.text();
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}${text.trim().length === 0 ? "" : `: ${text.slice(0, 200)}`}`);
            }
            if (text.trim().length === 0) {
                if (request.id !== undefined) {
                    throw new Error("empty HTTP response to JSON-RPC request");
                }
                return { jsonrpc: "2.0", id: 0, result: null };
            }
            const contentType: string = response.headers.get("content-type") ?? "";
            const payload: JsonRpcResponse = contentType.toLowerCase().includes("text/event-stream")
                ? parseSse(text, request.id)
                : (JSON.parse(text) as JsonRpcResponse);
            return payload;
        } finally {
            clearTimeout(timer);
        }
    }
}
