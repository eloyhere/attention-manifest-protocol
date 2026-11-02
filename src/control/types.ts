/** A control port is created by the authenticated host, never from tool arguments. */
export type ControlScope = "global" | "workspace" | "session";
export type ControlDomain = "adjust" | "interaction" | "scenario";
export type ControlErrorCode = "invalid_arguments" | "not_available" | "permission_denied" | "version_conflict" | "control_unavailable";
export class ControlError extends Error {
    readonly code: ControlErrorCode;
    constructor(code: ControlErrorCode) { super(code); this.name = "ControlError"; this.code = code; }
}
export interface ControlPort {
    call(scope: ControlScope, domain: ControlDomain, args: Record<string, unknown>): Record<string, unknown>;
}
export interface ControlIdentity {
    workspaceId: string;
    sessionId?: string;
    /** Global authority must be explicitly granted by the host. */
    allowGlobal?: boolean;
    /** Omitted grants global access to every workspace in this database. */
    authorizedWorkspaceIds?: readonly string[];
    /** Revalidate credentials/lifecycle at every call. Throw to deny access. */
    authenticate?: () => void;
}
