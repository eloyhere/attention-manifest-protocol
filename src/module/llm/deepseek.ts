/**
 * DeepSeek implementation of `LlmClient`.
 *
 * The API key is injected, never hardcoded. Thinking mode is disabled by default
 * so the runtime gets a deterministic final answer and only pays for output
 * tokens; usage is mapped back to the port.
 */
import type { LlmClient, LlmMessage, LlmRequest, LlmResponse } from "./llm.ts";

export interface DeepSeekLlmOptions {
    apiKey: string;
    baseUrl?: string;
    model?: string;
    timeoutMs?: number;
    retries?: number;
    fetchImpl?: typeof fetch;
    /**
     * Per-million-token prices; defaults are off-peak deepseek-flash.
     */
    inputMissPricePerMTok?: number;
    inputHitPricePerMTok?: number;
    outputPricePerMTok?: number;
}

export class DeepSeekError extends Error {
    readonly status: number;
    readonly retryable: boolean;

    constructor(status: number, message: string, retryable: boolean) {
        super(message);
        this.name = "DeepSeekError";
        this.status = status;
        this.retryable = retryable;
    }
}

interface DeepSeekUsage {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
}

interface DeepSeekToolCall {
    id: string;
    type?: string;
    function?: { name?: string; arguments?: string };
}

interface DeepSeekResponse {
    choices?: Array<{
        message?: { content?: string | null; tool_calls?: DeepSeekToolCall[] };
        finish_reason?: string | null;
    }>;
    usage?: DeepSeekUsage;
    error?: { message?: string };
}

const retryableStatus = (status: number): boolean => status === 429 || status === 500 || status === 502 || status === 503 || status === 504;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class DeepSeekLlm implements LlmClient {
    private readonly apiKey: string;
    private readonly baseUrl: string;
    private readonly model: string;
    private readonly timeoutMs: number;
    private readonly retries: number;
    private readonly fetchImpl: typeof fetch;
    private readonly inputMissPrice: number;
    private readonly inputHitPrice: number;
    private readonly outputPrice: number;

    constructor(options: DeepSeekLlmOptions) {
        if (options.apiKey.trim().length === 0) {
            throw new Error("DeepSeekLlm requires an apiKey");
        }
        this.apiKey = options.apiKey;
        this.baseUrl = (options.baseUrl ?? "https://api.deepseek.com").replace(/\/+$/, "");
        this.model = options.model ?? "deepseek-flash";
        this.timeoutMs = options.timeoutMs ?? 60_000;
        this.retries = Math.max(0, options.retries ?? 2);
        this.fetchImpl = options.fetchImpl ?? fetch;
        this.inputMissPrice = options.inputMissPricePerMTok ?? 0.15;
        this.inputHitPrice = options.inputHitPricePerMTok ?? 0.003;
        this.outputPrice = options.outputPricePerMTok ?? 0.6;
    }

    static fromEnv(env: NodeJS.ProcessEnv = process.env): DeepSeekLlm {
        const apiKey = env.DEEPSEEK_API_KEY;
        if (apiKey === (void 0) || apiKey.trim().length === 0) {
            throw new Error("DEEPSEEK_API_KEY is not set");
        }
        return new DeepSeekLlm({
            apiKey,
            baseUrl: env.DEEPSEEK_BASE_URL,
            model: env.DEEPSEEK_MODEL,
        });
    }

    async complete(request: LlmRequest): Promise<LlmResponse> {
        let lastError: unknown;
        for (let attempt = 0; attempt <= this.retries; attempt += 1) {
            try {
                return await this.once(request);
            } catch (error) {
                lastError = error;
                if (!(error instanceof DeepSeekError) || !error.retryable || attempt >= this.retries) {
                    throw error;
                }
                await sleep(250 * 2 ** attempt);
            }
        }
        throw lastError instanceof Error ? lastError : new Error("DeepSeek request failed");
    }

    private messagePayload(message: LlmMessage): Record<string, unknown> {
        const payload: Record<string, unknown> = { role: message.role, content: message.content };
        if (message.toolCalls !== (void 0)) {
            payload.content = message.content.length === 0 ? null : message.content;
            payload.tool_calls = message.toolCalls.map((call) => ({
                id: call.id,
                type: "function",
                function: { name: call.name, arguments: call.arguments },
            }));
        }
        if (message.toolCallId !== (void 0)) {
            payload.tool_call_id = message.toolCallId;
        }
        if (message.name !== (void 0)) {
            payload.name = message.name;
        }
        return payload;
    }

    private async once(request: LlmRequest): Promise<LlmResponse> {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
            const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${this.apiKey}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    model: request.model.length === 0 ? this.model : request.model,
                    messages: request.messages.map((message: LlmMessage) => this.messagePayload(message)),
                    thinking: { type: "disabled" },
                    temperature: request.temperature ?? 0,
                    ...(request.maxTokens === (void 0) ? {} : { max_tokens: request.maxTokens }),
                    ...(request.tools === (void 0)
                        ? {}
                        : {
                              tools: request.tools.map((tool) => ({
                                  type: "function",
                                  function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
                              })),
                          }),
                    stream: false,
                }),
                signal: controller.signal,
            });
            if (!response.ok) {
                let detail = "";
                try {
                    const body = (await response.json()) as DeepSeekResponse;
                    detail = body.error?.message ?? "";
                } catch {
                    detail = await response.text().catch(() => "");
                }
                throw new DeepSeekError(response.status, `DeepSeek HTTP ${response.status}: ${detail.slice(0, 400)}`, retryableStatus(response.status));
            }
            const body = (await response.json()) as DeepSeekResponse;
            const choice = body.choices?.[0];
            const text = choice?.message?.content ?? "";
            const rawCalls = choice?.message?.tool_calls ?? [];
            const toolCalls = rawCalls.map((call) => ({
                id: call.id,
                name: call.function?.name ?? "",
                arguments: call.function?.arguments ?? "{}",
            }));
            const finish = choice?.finish_reason;
            const finishReason: LlmResponse["finishReason"] =
                finish === "length" ? "length" : finish === "tool_calls" || toolCalls.length > 0 ? "tool_call" : "stop";
            const inputTokens = body.usage?.prompt_tokens ?? 0;
            const hit = body.usage?.prompt_cache_hit_tokens ?? 0;
            const miss = body.usage?.prompt_cache_miss_tokens ?? Math.max(0, inputTokens - hit);
            const costUsd = (hit * this.inputHitPrice + miss * this.inputMissPrice + (body.usage?.completion_tokens ?? 0) * this.outputPrice) / 1_000_000;
            return {
                text,
                usage: {
                    inputTokens,
                    outputTokens: body.usage?.completion_tokens ?? 0,
                    cacheHitTokens: hit,
                    cacheMissTokens: miss,
                    costUsd,
                },
                finishReason,
                ...(toolCalls.length === 0 ? {} : { toolCalls }),
            };
        } catch (error) {
            if (error instanceof DeepSeekError) {
                throw error;
            }
            if (error instanceof DOMException && error.name === "AbortError") {
                throw new DeepSeekError(0, `DeepSeek timeout after ${this.timeoutMs}ms`, true);
            }
            throw new DeepSeekError(0, error instanceof Error ? error.message : `${error}`, true);
        } finally {
            clearTimeout(timer);
        }
    }
}
