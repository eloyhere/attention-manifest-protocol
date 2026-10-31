import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Starts a server on an ephemeral port and resolves once it is listening.
 */
export const listen: (server: Server) => Promise<number> = (server: Server): Promise<number> => {
    return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const address: AddressInfo | string | null = server.address();
            if (!address || typeof(address) === "string") {
                reject(new Error("server did not bind to a TCP port"));
                return;
            }
            resolve(address.port);
        });
    });
};

/**
 * Returns the bound port, or throws instead of silently returning 0.
 */
export const portOf: (server: Server) => number = (server: Server): number => {
    const address: AddressInfo | string | null = server.address();
    if (!address || typeof(address) === "string") {
        throw new Error("server is not listening on a TCP port");
    }
    return address.port;
};

export const close: (server: Server) => Promise<void> = (server: Server): Promise<void> => {
    return new Promise((resolve) => server.close(() => resolve()));
};
