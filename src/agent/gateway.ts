import { createAgentSurface, createDiscoverySurface, DISCOVER_TOOL_NAME, findModule, findTool, assertBinding, assertModelParameters } from "./surface.ts";
import { DEFAULT_DISCOVERY_SOURCES, DISCOVERY_SOURCES, collectDiscoveryCandidates, discover, normalizeDiscoveryQuery, parseDiscoveryOptions } from "./discovery.ts";
import type { DiscoveryCandidate, DiscoveryHost, DiscoveryOptions, DiscoveryResult } from "./discovery.ts";
import type { AgentBinding, AgentSurface, ToolDescriptor } from "./surface.ts";

/** Typed failure of a gateway call; the code is stable for host mapping. */
export type GatewayErrorCode =
    | "binding_invalid"
    | "unknown_tool"
    | "not_exposed"
    | "invalid_parameters"
    | "unauthorized"
    | "mutating_requires_idempotency_key"
    | "handler_missing"
    | "handler_failed";

export class GatewayError extends Error {
    readonly code: GatewayErrorCode;

    constructor(code: GatewayErrorCode, message: string) {
        super(message);
        this.name = "GatewayError";
        this.code = code;
    }
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export interface GatewayCallContext {
    /** Host-bound identity; handlers must never take these from model parameters. */
    readonly binding: AgentBinding;
    readonly tool: ToolDescriptor;
    readonly idempotencyKey?: string;
}

export type GatewayHandler = (parameters: Readonly<Record<string, unknown>>, context: GatewayCallContext) => unknown;

export interface GatewayCallRecord {
    readonly tool: string;
    readonly mutating: boolean;
    readonly idempotencyKey?: string;
    readonly ok: boolean;
    readonly error?: GatewayErrorCode;
    readonly durationMs: number;
}

export interface AgentGatewayOptions {
    readonly handlers: Readonly<Record<string, GatewayHandler>>;
    /** Host policy hook; returning false yields `unauthorized`. */
    readonly authorize?: (authority: readonly string[], binding: AgentBinding) => boolean;
    /** Journal hook; called once per call, including failures. */
    readonly onCall?: (record: GatewayCallRecord) => void;
    /** Defaults to the full agent surface. */
    readonly surface?: AgentSurface;
    /** Opt in to a single bootstrap tool; candidate catalog remains the configured surface. */
    readonly discovery?: DiscoveryHost;
}

/**
 * Thin dispatch layer between the declarative agent surface and host handlers.
 *
 * The gateway enforces the mechanics the surface declares: known and exposed
 * tool, host-bound identity, no smuggled context parameters, an idempotency key
 * for mutating verbs, the host authorization hook, and one journal record per
 * call. It does not implement policy, budget or leases; those stay in the host.
 */
export class AgentGateway {
    private readonly surface: AgentSurface;
    private readonly handlers: Readonly<Record<string, GatewayHandler>>;
    private readonly authorize?: (authority: readonly string[], binding: AgentBinding) => boolean;
    private readonly onCall?: (record: GatewayCallRecord) => void;
    private readonly discovery?: DiscoveryHost;

    constructor(options: AgentGatewayOptions) {
        this.surface = options.surface ?? createAgentSurface();
        this.handlers = options.handlers;
        this.authorize = options.authorize;
        this.onCall = options.onCall;
        this.discovery = options.discovery;
        if (this.discovery) {
            if (!this.authorize) { throw new TypeError("discovery requires a host authorize hook"); }
            const seen = new Set<string>();
            for (const provider of this.discovery.providers ?? []) {
                if (!DISCOVERY_SOURCES.includes(provider.source) || (provider.source as string) === "amp") {
                    throw new TypeError(`invalid discovery provider source: ${provider.source}`);
                }
                if (seen.has(provider.source)) { throw new TypeError(`duplicate discovery provider source: ${provider.source}`); }
                seen.add(provider.source);
            }
        }
    }

    /** Model bootstrap list. Discovery does not expand this list or grant access by itself. */
    get tools(): readonly ToolDescriptor[] {
        return this.discovery ? createDiscoverySurface().tools : this.surface.tools;
    }

    /** Full configured catalog, for the host to expose selected contracts after discovery. */
    get catalog(): readonly ToolDescriptor[] {
        return this.surface.tools;
    }

    private async discover(parameters: Readonly<Record<string, unknown>>, binding: AgentBinding): Promise<DiscoveryResult> {
        const authorize = this.authorize;
        const host = this.discovery;
        if (!authorize || !host) { throw new GatewayError("not_exposed", "discovery is not configured"); }
        let options: DiscoveryOptions;
        try { options = parseDiscoveryOptions(parameters); }
        catch (error) { throw new GatewayError("invalid_parameters", messageOf(error)); }
        const query = normalizeDiscoveryQuery(options.query);
        const candidates: DiscoveryCandidate[] = [];
        const sources = options.sources ?? DEFAULT_DISCOVERY_SOURCES;
        for (const source of sources) {
            if (!authorize([`discovery:${source}`], binding)) { throw new GatewayError("unauthorized", `not authorized for discovery:${source}`); }
        }
        for (const offered of sources.includes("amp") ? this.surface.tools : []) {
            const canonical = findTool(offered.name);
            if (canonical.isEmpty() || offered.name === DISCOVER_TOOL_NAME) { continue; }
            const tool = canonical.get();
            if (typeof this.handlers[tool.name] !== "function" || !authorize(tool.authority, binding)) { continue; }
            const module = findModule(tool.module);
            candidates.push({ id: tool.name, source: "amp", kind: "tool", module: tool.module, name: tool.name,
                summary: tool.description,
                keywords: [tool.verb, tool.module, ...(tool.keywords ?? []), ...(module.isPresent() ? [module.get().summary] : []),
                    ...(host.keywords?.(tool) ?? [])],
                signals: host.signals?.(tool, query, binding), target: { kind: "surface", name: tool.name } });
        }
        const collected = await collectDiscoveryCandidates(host, options, binding);
        candidates.push(...collected.candidates);
        return { ...discover(candidates, options), unavailableSources: collected.unavailable };
    }

    call(
        name: string,
        parameters: Readonly<Record<string, unknown>> = {},
        options: { readonly binding: AgentBinding; readonly idempotencyKey?: string },
    ): unknown {
        const startedAt = Date.now();
        let tool: ToolDescriptor | undefined;
        try {
            try {
                assertBinding(options.binding);
            } catch (error) {
                throw new GatewayError("binding_invalid", messageOf(error));
            }
            const found = findTool(name);
            if (found.isEmpty()) throw new GatewayError("unknown_tool", `unknown tool: ${name}`);
            tool = found.get();
            const isDiscovery = name === DISCOVER_TOOL_NAME && this.discovery !== undefined;
            if (!isDiscovery && !this.surface.tools.some(candidate => candidate.name === tool!.name)) {
                throw new GatewayError("not_exposed", `tool ${name} is not exposed by this surface`);
            }
            try {
                assertModelParameters(parameters);
            } catch (error) {
                throw new GatewayError("invalid_parameters", messageOf(error));
            }
            const idempotencyKey = options.idempotencyKey;
            if (tool.mutating && (idempotencyKey === undefined || idempotencyKey.trim() === "")) {
                throw new GatewayError("mutating_requires_idempotency_key", `mutating tool ${name} requires an idempotency key`);
            }
            if (this.authorize !== undefined && !this.authorize(tool.authority, options.binding)) {
                throw new GatewayError("unauthorized", `not authorized for ${tool.authority.join(", ")}`);
            }
            const handler: GatewayHandler | undefined = isDiscovery
                ? (parameters, context) => this.discover(parameters, context.binding)
                : this.handlers[name];
            if (handler === undefined) throw new GatewayError("handler_missing", `no handler registered for ${name}`);
            const context: GatewayCallContext = Object.freeze({
                binding: options.binding,
                tool,
                ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
            });
            const result = handler(parameters, context);
            if (result instanceof Promise) {
                return result.then(value => {
                    this.journal({ tool: name, mutating: tool!.mutating, ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
                        ok: true, durationMs: Date.now() - startedAt });
                    return value;
                }, error => {
                    const code: GatewayErrorCode = error instanceof GatewayError ? error.code : "handler_failed";
                    this.journal({ tool: name, mutating: tool!.mutating, ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
                        ok: false, error: code, durationMs: Date.now() - startedAt });
                    if (error instanceof GatewayError) { throw error; }
                    throw new GatewayError("handler_failed", messageOf(error));
                });
            }
            this.journal({ tool: name, mutating: tool.mutating, ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
                ok: true, durationMs: Date.now() - startedAt });
            return result;
        } catch (error) {
            const code: GatewayErrorCode = error instanceof GatewayError ? error.code : "handler_failed";
            this.journal({ tool: name, mutating: tool?.mutating ?? false, ...(options.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey }),
                ok: false, error: code, durationMs: Date.now() - startedAt });
            if (error instanceof GatewayError) throw error;
            throw new GatewayError("handler_failed", messageOf(error));
        }
    }

    private journal(record: GatewayCallRecord): void {
        this.onCall?.(Object.freeze(record));
    }
}
