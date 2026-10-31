/**
 * LLM port. The kernel never calls a provider directly; it asks a client for a
 * completion and records the usage. `ScriptedLlm` makes the loop testable
 * without network access.
 */
export type LlmRole = "system" | "user" | "assistant" | "tool";

export interface LlmToolCall {
    id: string;
    name: string;
    arguments: string;
}

export interface LlmToolDefinition {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
}

export interface LlmMessage {
    role: LlmRole;
    content: string;
    /**
     * Assistant tool calls, or the tool result correlation id.
     */
    toolCalls?: LlmToolCall[];
    toolCallId?: string;
    name?: string;
}

export interface LlmRequest {
    model: string;
    messages: LlmMessage[];
    maxTokens?: number;
    temperature?: number;
    tools?: LlmToolDefinition[];
}

export interface LlmUsage {
    inputTokens: number;
    outputTokens: number;
    /**
     * Prompt tokens served from cache, when the provider reports it.
     */
    cacheHitTokens?: number;
    /**
     * Prompt tokens not served from cache.
     */
    cacheMissTokens?: number;
    /**
     * Provider-reported or adapter-computed cost.
     */
    costUsd?: number;
}

export interface LlmResponse {
    text: string;
    usage: LlmUsage;
    finishReason: "stop" | "length" | "tool_call";
    toolCalls?: LlmToolCall[];
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

    async complete(request: LlmRequest): Promise<LlmResponse> {
        void request;
        this.calls += 1;
        const response: LlmResponse | undefined = this.responses.shift();
        if (response === (void 0)) {
            throw new Error("scripted LLM has no response left");
        }
        return response;
    }
}
