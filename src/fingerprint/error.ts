/**
 * The failure taxonomy of the fingerprint module.
 *
 * A caller has to be able to tell four situations apart: the algorithm is not
 * available in this build, the kind is outside the frozen set, the chosen
 * policy refused the input, or a comparison failed. Treating them as one
 * generic error forces the caller either to swallow an integrity failure or to
 * retry a permanent bug, so the code is part of the contract and not just a
 * diagnostic string. The base class mirrors `src/error/ampError.ts`: one
 * machine-readable code plus every problem found in the same attempt.
 */
import { AmpError } from "../error/ampError.ts";

/**
 * Stable machine-readable reasons; callers may switch on these.
 */
export type FingerprintErrorCode =
    | "unsupported_algorithm"
    | "unsupported_kind"
    | "unsupported_policy"
    | "normalization_rejected"
    | "fingerprint_mismatch"
    | "fingerprint_io_error"
    | "invalid_ref"
    | "hasher_finished";

/**
 * Base class for every rejection this module raises.
 *
 * `problems` is plural because one input can violate several rules at once and
 * a caller should see all of them, exactly like the boundary rejections in
 * `src/error/boundaryRejection.ts`. The `name` parameter exists only so the
 * subclasses below can keep `error.name` useful when they call `super`.
 */
export class FingerprintError extends AmpError {
    constructor(code: FingerprintErrorCode, problems: readonly string[], name: string = "FingerprintError") {
        super(name, code, problems);
    }
}

/**
 * The algorithm id is not registered, or it is registered but this build has no
 * backend for it. Never downgraded to SHA-256: a silent fallback would make the
 * algorithm name in the reference a lie.
 */
export class UnsupportedAlgorithm extends FingerprintError {
    constructor(problems: readonly string[]) {
        super("unsupported_algorithm", problems, "UnsupportedAlgorithm");
    }
}

/**
 * The kind is outside the frozen `FingerprintKind` set, so no preimage header
 * could be built without inventing a field the verifier does not know.
 */
export class UnsupportedKind extends FingerprintError {
    constructor(problems: readonly string[]) {
        super("unsupported_kind", problems, "UnsupportedKind");
    }
}

/**
 * A policy refused the input: a lone surrogate, `-0`, a non-finite number,
 * invalid UTF-8, a NUL inside `text`. Retrying with the same arguments cannot
 * succeed, which is what separates this from an I/O failure.
 */
export class NormalizationRejected extends FingerprintError {
    constructor(problems: readonly string[]) {
        super("normalization_rejected", problems, "NormalizationRejected");
    }
}

/**
 * Two references that should describe the same value do not. Both references
 * are in the message because a bare "digest mismatch" cannot be debugged from
 * a log line.
 */
export class FingerprintMismatch extends FingerprintError {
    constructor(problems: readonly string[]) {
        super("fingerprint_mismatch", problems, "FingerprintMismatch");
    }
}

/**
 * The file system refused the read: missing path, directory where a file was
 * expected, a symlink the caller may not follow, or a file that changed size
 * while it was being streamed.
 */
export class FingerprintIOError extends FingerprintError {
    constructor(problems: readonly string[]) {
        super("fingerprint_io_error", problems, "FingerprintIOError");
    }
}

/**
 * Render an unknown thrown value for a diagnostic. `String(error)` is avoided
 * on purpose: it turns a thrown object into `[object Object]`, while the
 * `message` of a Node system error (`ENOENT: no such file ...`) is the part a
 * human needs.
 */
export const describeError: (error: unknown) => string = (error: unknown): string => {
    if (error instanceof Error) {
        return error.message;
    }
    return `${error}`;
};
