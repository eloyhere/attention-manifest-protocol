/**
 * Session identity generation and token verification.
 *
 * A session id is a public handle; the bearer token is the secret. Only the
 * token hash is ever stored, and verification uses a constant-time comparison
 * that still runs when the stored hash is missing, truncated or otherwise
 * malformed, so a caller cannot learn the expected length from a throw.
 */
import { Buffer } from "node:buffer";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { fail } from "./errors.ts";
import type { SessionId } from "./types.ts";

const SessionIdPrefix: string = "ses_";
const SessionIdBytes: number = 16;
const TokenBytes: number = 32;
const HashPrefix: string = "sha256:";

/**
 * Allocate a public session handle: `ses_` plus 32 lowercase hex characters.
 */
export const createSessionId: () => SessionId = (): SessionId => `${SessionIdPrefix}${randomBytes(SessionIdBytes).toString("hex")}`;

/**
 * Allocate a 32-byte bearer token encoded as base64url without padding.
 */
export const createSessionToken: () => string = (): string => randomBytes(TokenBytes).toString("base64url");

/**
 * Hash a token for storage as `sha256:<hex>`.
 *
 * The raw token never reaches the store; callers that persist the hash cannot
 * reconstruct the secret from it.
 */
export const hashSessionToken: (token: string) => string = (token: string): string => {
    if (typeof(token) !== "string") {
        return fail("invalid_arguments");
    }
    return `${HashPrefix}${createHash("sha256").update(token, "utf8").digest("hex")}`;
};

/**
 * Compare a token against a stored `sha256:<hex>` digest in constant time.
 *
 * Both sides are copied into equal-width buffers before `timingSafeEqual`, so a
 * length mismatch performs one comparison and returns `false` instead of
 * throwing. A non-string argument is rejected the same way.
 */
export const verifySessionToken: (token: string, expectedHash: string) => boolean = (token: string, expectedHash: string): boolean => {
    if (typeof(token) !== "string" || typeof(expectedHash) !== "string") {
        return false;
    }
    const actual: Buffer = Buffer.from(hashSessionToken(token), "utf8");
    const expected: Buffer = Buffer.from(expectedHash, "utf8");
    const width: number = Math.max(actual.length, expected.length, 1);
    const left: Buffer = Buffer.alloc(width);
    const right: Buffer = Buffer.alloc(width);
    actual.copy(left, 0);
    expected.copy(right, 0);
    const equal: boolean = timingSafeEqual(left, right);
    return equal && actual.length === expected.length;
};
