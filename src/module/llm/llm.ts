/**
 * LLM port. The kernel never calls a provider directly; it asks a client for a
 * completion and records the usage. `ScriptedLlm` makes the loop testable
 * without network access.
 */
export type LlmRole = "system" | "user" | "assistant" | "tool";

export interface LlmMessage {
    role: LlmRole;
    content: string;
}

export interface LlmRequest {
    model: string;
    messages: LlmMessage[];
    maxTokens?: number;
    temperature?: number;
}

export interface LlmUsage {
    inputTokens: number;
    outputTokens: number;
}

export interface LlmResponse {
    text: string;
    usage: LlmUsage;
    finishReason: "stop" | "length" | "tool_call";
}

export interface LlmClient {
    complete(request: LlmRequest): Promise<LlmResponse>;
}

export class ScriptedLlm implements LlmClient {
    private readonly responses: LlmResponse[];
    calls: number = 0;

    constructor(responses: LlmResponse[]) {
        this.responses = [...responses];
    }

    async complete(_request: LlmRequest): Promise<LlmResponse> {
        this.calls += 1;
        const response: LlmResponse | undefined = this.responses.shift();
        if (response === undefined) throw new Error("scripted LLM has no response left");
        return response;
    }
}
