/**
 * Local HTTP host for the cooperation bus.
 *
 * This is the smallest real server that can sit behind
 * `HttpCooperationTransport`: POST a JSON envelope, receive a `Delivery` body.
 * Authentication, clock skew and replay are handled by the transport handler;
 * the server only enforces method, path and body size.
 */
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import type { CooperationBus } from "./cooperation.ts";
import type { CooperationHandlerOptions, CooperationHttpResponse } from "./transport.ts";
import { createCooperationHandler } from "./transport.ts";

export interface CooperationServerOptions extends CooperationHandlerOptions {
    host?: string;
    port?: number;
    path?: string;
    maxBodyBytes?: number;
}

export interface RunningCooperationServer {
    server: Server;
    port: number;
    url: string;
    close: () => Promise<void>;
}

const readBody: (request: IncomingMessage, maxBytes: number) => Promise<string> = (request: IncomingMessage, maxBytes: number): Promise<string> => {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size: number = 0;
        request.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > maxBytes) {
                reject(new Error(`request body exceeds ${maxBytes} bytes`));
                request.destroy();
                return;
            }
            chunks.push(chunk);
        });
        request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        request.on("error", reject);
    });
};

type StartServerFn = (bus: CooperationBus, options?: CooperationServerOptions) => Promise<RunningCooperationServer>;

export const startCooperationServer: StartServerFn = async (bus, options = {}) => {
    const host: string = options.host ?? "127.0.0.1";
    const port: number = options.port ?? 0;
    const path: string = options.path ?? "/cooperation";
    const maxBodyBytes: number = options.maxBodyBytes ?? 1_048_576;
    const handler: ReturnType<typeof createCooperationHandler> = createCooperationHandler(bus, options);
    const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
        void (async (): Promise<void> => {
            if (request.method !== "POST" || request.url !== path) {
                response.writeHead(404, { "Content-Type": "application/json" });
                response.end(JSON.stringify({ ok: false, code: "transport-error", detail: `expected POST ${path}` }));
                return;
            }
            try {
                const text: string = await readBody(request, maxBodyBytes);
                const body: unknown = JSON.parse(text);
                const result: CooperationHttpResponse = await handler(body);
                response.writeHead(result.status, { "Content-Type": "application/json" });
                response.end(JSON.stringify(result.body));
            } catch (error) {
                response.writeHead(400, { "Content-Type": "application/json" });
                response.end(
                    JSON.stringify({
                        ok: false,
                        code: "transport-error",
                        detail: error instanceof Error ? error.message : `${error}`,
                    }),
                );
            }
        })();
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => resolve());
    });
    const address: AddressInfo | string | null = server.address();
    if (address === null || typeof(address) === "string") {
        throw new Error("cooperation server did not bind to a TCP port");
    }
    return {
        server,
        port: address.port,
        url: `http://${host}:${address.port}${path}`,
        close: (): Promise<void> =>
            new Promise((resolve) => {
                server.close(() => resolve());
            }),
    };
};
