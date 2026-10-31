/**
 * Public session entry: identity, lifecycle, context isolation and ports.
 *
 * `src/session` is the data-isolation boundary for one agent's workspace work.
 * It is intentionally separate from `runtime/session.ts`, the cognitive memory
 * of a turn loop, and it never shares mutable state with it.
 */
export { SessionError, fail, isSessionError } from "./errors.ts";
export { createSessionId, createSessionToken, hashSessionToken, verifySessionToken } from "./identity.ts";
export { SessionContexts } from "./context.ts";
export type { SessionContextOptions } from "./context.ts";
export { SessionRegistry } from "./registry.ts";
export type { SessionRotationStore } from "./registry.ts";
export * from "./types.ts";
