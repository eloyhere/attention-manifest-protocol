import type { FileStoragePort, OutlineProvider } from "../file/types.ts";
import type { Identifier } from "../shared.ts";

export type {
    ByteTarget, EditMatch, EditOptions, EditPlan, FileConflict, FileLease, FileRange, FileRangeBounds, FileRef,
    FileSnapshot, FileState, FileStoragePort, LineTarget, MountOptions, OutlineEntry, OutlineProvider, OutlineTarget,
    ReadOptions, RegexTarget, ReloadOptions, ReplaceMode, ReplaceTarget, StoredFile, StringTarget, UnmountOptions,
    WorkspaceMode, WorkspaceScope, WriteMode, WriteTarget,
} from "../file/types.ts";
export type { ProjectMetadata, ProjectOptions, ProjectRule, ProjectRuleInput, ProjectScope, ProjectView, ViewKind } from "../project/types.ts";

export interface WorkspaceOptions {
    readonly tenantId: Identifier;
    readonly rootId: Identifier;
    readonly storage: FileStoragePort;
    readonly clock?: () => string;
    /** Default outline provider for `outline` edit targets on every file of this workspace. */
    readonly outline?: OutlineProvider;
}

export type WorkspaceErrorCode =
    | "not_found"
    | "invalid_path"
    | "invalid_scope"
    | "read_only"
    | "dirty"
    | "stale"
    | "version_conflict"
    | "fence_rejected"
    | "not_mounted"
    | "already_mounted"
    | "invalid_range"
    | "duplicate"
    | "invalid_project"
    | "invalid_target"
    | "no_match"
    | "ambiguous_match"
    | "outline_unavailable"
    | "buffer_conflict"
    | "io_error"
    | "binary_file"
    | "file_too_large"
    | "mixed_eol";

export class WorkspaceError extends Error {
    readonly code: WorkspaceErrorCode;
    constructor(code: WorkspaceErrorCode, message: string) {
        super(message);
        this.name = "WorkspaceError";
        this.code = code;
    }
}
