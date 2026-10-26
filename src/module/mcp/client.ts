import type { CallToolResult, DiscoveryResult, JsonRpcRequest, JsonRpcResponse, ListToolsResult } from "./protocol.ts";
import { McpProtocolError, PROTOCOL_VERSION } from "./protocol.ts";
import type { Transport } from "./transport.ts";

/**
 * Stateless MCP client (2026-07-28).
 *
 * No initialize handshake, no session id: version and capabilities travel in
 * `_meta` on every request, exactly as the revision requires.
 */
export const LEGACY_VERSION = "2025-06-18";

export class McpClient {
    readonly transport: Transport;
    readonly clientName: string;
    protocolVersion: string = PROTOCOL_VERSION;
    legacy: boolean = false;
    private seq = 0;

    constructor(transport: Transport, clientName = "amp-reference") {
        this.transport = transport;
        this.clientName = clientName;
    }

    private meta(): Record<string, unknown> {
        return {
            "io.modelcontextprotocol/protocolVersion": this.protocolVersion,
            "io.modelcontextprotocol/clientCapabilities": {},
            "io.modelcontextprotocol/clientInfo": { name: this.clientName, version: "0.1.0" },
        };
    }

    private async request<T>(method: string, params: Record<string, unknown> = {}, withMeta = true): Promise<T> {
        this.seq += 1;
        const extraMeta = params._meta as Record<string, unknown> | undefined;
        const request: JsonRpcRequest = {
            jsonrpc: "2.0",
            id: this.seq,
            method,
            params: withMeta ? { ...params, _meta: { ...this.meta(), ...(extraMeta ?? {}) } } : params,
        };
        const response: JsonRpcResponse = await this.transport.send(request);
        if (response.error) {
            throw new McpProtocolError(response.error.code, response.error.message, response.error.data);
        }
        return response.result as T;
    }

    /** Legacy 2025-06-18 handshake. Only used when server/discover is unavailable. */
    async initializeLegacy(): Promise<void> {
        this.protocolVersion = LEGACY_VERSION;
        const transport = this.transport as { protocolVersion?: string };
        if (typeof(transport.protocolVersion) === "string") transport.protocolVersion = LEGACY_VERSION;

        await this.request<{ protocolVersion: string }>(
            "initialize",
            {
                protocolVersion: LEGACY_VERSION,
                capabilities: {},
                clientInfo: { name: this.clientName, version: "0.1.0" },
            },
            false,
        );
        await this.transport.send({ jsonrpc: "2.0", method: "notifications/initialized" });
        this.legacy = true;
    }

    /** Stateless first; fall back to the legacy handshake only on protocol errors. */
    async negotiate(): Promise<{ mode: "stateless" | "legacy" }> {
        try {
            const discovery = await this.discover();
            this.protocolVersion = discovery.supportedVersions[0] ?? PROTOCOL_VERSION;
            return { mode: "stateless" };
        } catch (error) {
            if (!(error instanceof McpProtocolError)) throw error;
            await this.initializeLegacy();
            return { mode: "legacy" };
        }
    }

    discover(): Promise<DiscoveryResult> {
        return this.request<DiscoveryResult>("server/discover");
    }

    listTools(): Promise<ListToolsResult> {
        return this.request<ListToolsResult>("tools/list");
    }

    callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
        return this.request<CallToolResult>("tools/call", { name, arguments: args });
    }
}
