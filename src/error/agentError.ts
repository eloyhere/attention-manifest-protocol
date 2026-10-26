import type { AgentErrorCode } from "../process/agent.ts";

/** Domain error for the agent facets; never a database error. */
export class AgentError extends Error {
    readonly code: AgentErrorCode;
    readonly details: readonly string[];

    constructor(code: AgentErrorCode, details: readonly string[] = []) {
        super(details.length === 0 ? code : `${code}: ${details.join("; ")}`);
        this.name = "AgentError";
        this.code = code;
        this.details = details;
    }
}
