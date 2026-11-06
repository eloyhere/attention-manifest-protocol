/**
 * Declarative description of a project toolchain "serie" (package manager,
 * runtime, build system or mobile platform).
 *
 * A serie never executes commands or touches the file system. It only declares
 * the workspace-relative evidence that identifies it and the commands a host
 * may choose to run.
 */
export interface SerieMarker {
    /** Workspace-relative POSIX path used as evidence. */
    readonly path: string;
    /** exact = the complete path; prefix = a directory path; suffix = end of the complete path. */
    readonly match: "exact" | "prefix" | "suffix";
    /** Evidence strength, an integer from 1 to 3. */
    readonly weight: number;
    /** Human-readable explanation of the evidence. */
    readonly label: string;
}

export type SerieKind = "package-manager" | "runtime" | "build-system" | "platform";

export type SerieCapability = "install" | "build" | "test" | "run" | "lint" | "package" | "bundle";

export interface SerieStep { readonly capability: SerieCapability; readonly command: string }

export interface SerieDefinition {
    /** Normalized lowercase identifier, for example "npm". */
    readonly id: string;
    readonly displayName: string;
    readonly kind: SerieKind;
    readonly markers: readonly SerieMarker[];
    readonly capabilities: readonly SerieCapability[];
    readonly steps: readonly SerieStep[];
    /** Tie-breaker in the range 0..100; higher values sort first. */
    readonly priority: number;
    readonly notes?: string;
}

export interface SerieDetection {
    readonly serie: SerieDefinition;
    /** Sum of the weights of all matched markers. */
    readonly score: number;
    readonly matched: readonly SerieMarker[];
    /** The first matching file for each entry of `matched`, in the same order. */
    readonly evidence: readonly string[];
}
