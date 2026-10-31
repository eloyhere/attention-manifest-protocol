/**
 * Shared base for AMP errors that carry a machine-readable code and every
 * problem found in one attempt.
 *
 * Boundary rejections are the first user; other fail-closed paths can extend
 * this without changing their own extra fields. The `code` stays narrow through
 * the generic parameter, so `catch (error) { if (error instanceof BoundaryRejection) ... }`
 * still sees a literal union.
 */
export class AmpError<Code extends string = string> extends Error {
    readonly code: Code;
    readonly problems: readonly string[];

    constructor(name: string, code: Code, problems: readonly string[]) {
        super(`${code}: ${problems.join("; ")}`);
        this.name = name;
        this.code = code;
        this.problems = [...problems];
    }
}
