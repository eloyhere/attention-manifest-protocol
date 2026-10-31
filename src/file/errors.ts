/**
 * Closed error taxonomy for the filesystem domain.
 *
 * Messages are the code itself. Host paths, specifiers and raw parser output
 * stay out of the error string so a transport can forward it to a model
 * without leaking the host layout.
 */
import type { FilesystemErrorCode } from "./types.ts";

export class FilesystemError extends Error {
    readonly code: FilesystemErrorCode;

    constructor(code: FilesystemErrorCode) {
        super(code);
        this.name = "FilesystemError";
        this.code = code;
    }
}

/**
 * Throw one classified failure.
 */
export const fail: (code: FilesystemErrorCode) => never = (code: FilesystemErrorCode): never => {
    throw new FilesystemError(code);
};

/**
 * Narrow an unknown thrown value to this domain's error.
 */
export const isFilesystemError: (error: unknown) => error is FilesystemError = (error: unknown): error is FilesystemError =>
    error instanceof FilesystemError;
