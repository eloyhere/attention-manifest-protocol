import { Optional, SynchronousUnorderedSet, isString, useFrom } from "semantic-typescript";
import type { ExecutionContext, JsonValue } from "../shared.ts";
import type { CompiledContext } from "../attention.ts";

/** A model supplies proposals only. The host owns authorization and state changes. */
export interface ActionProposal {
    kind: "action";
    toolId: string;
    arguments: JsonValue;
    reason: string;
}
export interface ResponseProposal {
    kind: "response";
    text: string;
    evidenceIds: readonly string[];
}
export type ModelProposal = ActionProposal | ResponseProposal;
export interface ModelRequest {
    context: Readonly<ExecutionContext>;
    compiled: CompiledContext;
    allowedToolIds: readonly string[];
}
export interface ModelPort {
    propose(request: ModelRequest, signal?: AbortSignal): Promise<ModelProposal>;
}

/** No LLM SDK is implied. The supplied port can wrap a provider or a test double. */
export async function proposeNextStep(port: ModelPort, request: ModelRequest, signal?: AbortSignal): Promise<ModelProposal> {
    if (request.context.tenantId !== request.compiled.scope.tenantId
        || request.context.sessionId !== request.compiled.scope.sessionId
        || request.context.principalId !== request.compiled.scope.principalId) {
        throw new Error("Model context scope mismatch");
    }
    Optional.ofNullable(signal).ifPresent(value => value.throwIfAborted());
    const tools = new SynchronousUnorderedSet(request.allowedToolIds);
    const snapshot = structuredClone(request);
    const proposal = await port.propose(snapshot, signal);
    Optional.ofNullable(signal).ifPresent(value => value.throwIfAborted());
    if (proposal.kind === "action") {
        if (!isString(proposal.toolId) || !tools.contains(proposal.toolId) || !isString(proposal.reason) || !proposal.reason.trim()) {
            throw new Error("Model proposed an unavailable tool or omitted its reason");
        }
    } else if (proposal.kind === "response") {
        const supplied = useFrom(proposal.evidenceIds).distinct().toCollectable().toArray();
        if (!isString(proposal.text) || !proposal.text.trim() || supplied.length !== proposal.evidenceIds.length) {
            throw new Error("Invalid response proposal");
        }
    } else {
        throw new Error("Unsupported model proposal");
    }
    return structuredClone(proposal);
}
