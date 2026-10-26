/**
 * Boundary rejections: the only error a constructor in `src/boundary` may throw.
 *
 * The point of the boundary is that an invalid object is never returned. A
 * constructor therefore fails as a whole, carrying every problem it found, so
 * a caller can log one machine-readable reason and one audit receipt instead of
 * a partially valid object that a later checker may or may not notice.
 */
import { AmpError } from "./ampError.ts";

/**
 * Stable machine-readable reasons; callers may switch on these.
 */
export type BoundaryCode = "invalid_frame" | "invalid_tool_args" | "unresolvable_ref" | "duplicate_ref" | "invalid_id";

export class BoundaryRejection extends AmpError<BoundaryCode> {
    constructor(code: BoundaryCode, problems: readonly string[]) {
        super("BoundaryRejection", code, problems);
    }
}
