import type { JsonRpcRequest, JsonRpcResponse } from "./protocol.ts";

/**
 * The only thing a host swaps to move from in-process to HTTP/stdio.
 * Requests are stateless: no initialize, no session id.
 */
export interface Transport {
    send(request: JsonRpcRequest): Promise<JsonRpcResponse>;
}

export type Handler = (request: JsonRpcRequest) => JsonRpcResponse | Promise<JsonRpcResponse>;

/**
 * In-process transport used by the demo and tests.
 */
export class MemoryTransport implements Transport {
    readonly handler: Handler;
    readonly history: JsonRpcRequest[] = [];
    sent: number = 0;

    constructor(handler: Handler) {
        this.handler = handler;
    }

    async send(request: JsonRpcRequest): Promise<JsonRpcResponse> {
        this.sent += 1;
        this.history.push(request);
        return await this.handler(request);
    }
}
