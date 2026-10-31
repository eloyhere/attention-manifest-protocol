import type { CallToolResult, DiscoveryResult, JsonRpcRequest, JsonRpcResponse, ListToolsResult } from "./protocol.ts";
import { McpProtocolError, ProtocolVersion } from "./protocol.ts";
import type { Transport } from "./transport.ts";

/**
 * Stateless MCP client (2026-07-28).
 *
 * No initialize handshake, no session id: version and capabilities travel in
 * `_meta` on every request, exactly as the revision requires.
 */
export const LegacyVersion: string = "2025-06-18";

type ProtocolVersionCarrier = {
    protocolVersion?: string;
};

type InitializeResult = {
    protocolVersion: string;
};

export class McpClient {
    readonly transport: Transport;
    readonly clientName: string;
    protocolVersion: string = ProtocolVersion;
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
        const extraMeta: Record<string, unknown> | undefined = params._meta as Record<string, unknown> | undefined;
        const request: JsonRpcRequest = {
            jsonrpc: "2.0",
            id: this.seq,
            method,
            params: withMeta ? { ...params, _meta: { ...this.meta(), ...(extraMeta ?? {}) } } : params,
        };
        const response: JsonRpcResponse = await this.transport.send(request);
        if (response === null || typeof(response) !== "object" || Array.isArray(response)) {
            throw new Error("invalid JSON-RPC response object");
        }
        if (response.jsonrpc !== "2.0" || response.id !== request.id) {
            throw new Error("JSON-RPC response version or id does not match request");
        }
        const hasResult: boolean = Object.prototype.hasOwnProperty.call(response, "result");
        const hasError: boolean = Object.prototype.hasOwnProperty.call(response, "error");
        if (hasResult === hasError) {
            throw new Error("JSON-RPC response must contain exactly one of result or error");
        }
        if (hasError) {
            const rpcError: unknown = response.error;
            if (
                rpcError === null ||
                typeof(rpcError) !== "object" ||
                !Number.isInteger((rpcError as { code?: unknown }).code) ||
                typeof((rpcError as { message?: unknown }).message) !== "string"
            ) {
                throw new Error("invalid JSON-RPC error object");
            }
            const error = rpcError as { code: number; message: string; data?: unknown };
            throw new McpProtocolError(error.code, error.message, error.data);
        }
        return response.result as T;
    }

    /**
     * Legacy 2025-06-18 handshake. Only used when server/discover is unavailable.
     */
    async initializeLegacy(): Promise<void> {
        this.protocolVersion = LegacyVersion;
        const transport: ProtocolVersionCarrier = this.transport as ProtocolVersionCarrier;
        if (typeof(transport.protocolVersion) === "string") {
            transport.protocolVersion = LegacyVersion;
        }

        await this.request<InitializeResult>(
            "initialize",
            {
                protocolVersion: LegacyVersion,
                capabilities: {},
                clientInfo: { name: this.clientName, version: "0.1.0" },
            },
            false,
        );
        await this.transport.send({ jsonrpc: "2.0", method: "notifications/initialized" });
        this.legacy = true;
    }

    /**
     * Stateless first; fall back to the legacy handshake only on protocol errors.
     */
    async negotiate(): Promise<{
        mode: "stateless" | "legacy";
    }> {
        try {
            const discovery: DiscoveryResult = await this.discover();
            this.protocolVersion = discovery.supportedVersions[0] ?? ProtocolVersion;
            return { mode: "stateless" };
        } catch (error) {
            if (!(error instanceof McpProtocolError)) {
                throw error;
            }
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
