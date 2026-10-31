/**
 * Closed error taxonomy for the session domain.
 *
 * Messages are the code itself. Root paths, agent ids, context keys and bearer
 * tokens stay out of the error string so a transport can forward it to a model
 * without leaking host layout or credentials.
 */
import type { SessionErrorCode } from "./types.ts";

/**
 * One classified session failure. The message mirrors {@link code} exactly so
 * an adapter never has to parse English prose and never receives a host path.
 */
export class SessionError extends Error {
    readonly code: SessionErrorCode;

    constructor(code: SessionErrorCode) {
        super(code);
        this.name = "SessionError";
        this.code = code;
    }
}

/**
 * Throw one classified failure.
 */
export const fail: (code: SessionErrorCode) => never = (code: SessionErrorCode): never => {
    throw new SessionError(code);
};

/**
 * Narrow an unknown thrown value to this domain's error.
 */
export const isSessionError: (error: unknown) => error is SessionError = (error: unknown): error is SessionError => error instanceof SessionError;
