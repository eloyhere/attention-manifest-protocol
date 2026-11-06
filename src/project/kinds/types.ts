import type { ProjectEnvironment } from "../environment.ts";

/**
 * Declarative description of a project kind: the kind of workspace a project
 * represents and the evidence and environment it implies.
 *
 * A definition never reads the file system or executes anything. It only
 * declares workspace-relative markers a host can match and the environment a
 * host may prepare.
 */

/** One workspace-relative piece of evidence used to recognize a project kind. */
export interface ProjectMarker {
    /** Workspace-relative POSIX path or path ending used as evidence. */
    readonly path: string;
    /** exact = the complete path; prefix = a directory path; suffix = end of the complete path. */
    readonly match: "exact" | "prefix" | "suffix";
    /** Evidence strength, an integer from 1 to 3. */
    readonly weight: number;
    /** Human-readable explanation of the evidence. */
    readonly label: string;
}

/** A project kind definition: identity, evidence and environment. */
export interface ProjectKindDefinition {
    /** Lowercase identifier, for example "go" or "solidworks". */
    readonly id: string;
    readonly displayName: string;
    /** Language identifier corresponding to the kind, for example "tex". */
    readonly language: string;
    readonly markers: readonly ProjectMarker[];
    readonly environment: ProjectEnvironment;
    /** Tie-breaker in the range 0..100; higher values sort first. */
    readonly priority: number;
    readonly notes?: string;
}

/** Result of matching a project kind against a host-supplied file list. */
export interface ProjectKindMatch {
    readonly kind: ProjectKindDefinition;
    /** Sum of the weights of all matched markers. */
    readonly score: number;
    /** Markers that matched, in definition order. */
    readonly matched: readonly ProjectMarker[];
    /** The first matching file for each entry of `matched`, in the same order. */
    readonly evidence: readonly string[];
}
