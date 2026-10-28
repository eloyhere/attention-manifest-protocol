/**
 * Transport seam for multi-agent governance messages.
 *
 * The bus owns validation; the transport only moves a sealed `AgentMessage`.
 * Two implementations ship here:
 *   - Loopback: a direct call, for tests and single-process teams;
 *   - HTTP: POST a JSON envelope to an endpoint and require a `Delivery` back.
 *
 * HTTP can be authenticated with Ed25519. The sender signs
 * `{message, signer, timestamp, nonce}`; the handler checks the signature, the
 * clock skew and a replay window before it calls `bus.receive()`. The message's
 * own credential still authorises the task; transport authentication is a
 * separate layer.
 */
import type { KeyPair } from "../manifest/sign.ts";
import type { AgentMessage, CooperationBus, Delivery } from "./cooperation.ts";
import type { GovernanceKeyring } from "./signing.ts";
import { signCanonicalValue, verifyCanonicalValue } from "./signing.ts";

export interface CooperationTransport {
    deliver(message: AgentMessage): Promise<Delivery>;
}

export class LoopbackTransport implements CooperationTransport {
    private readonly bus: CooperationBus;

    constructor(bus: CooperationBus) {
        this.bus = bus;
    }

    async deliver(message: AgentMessage): Promise<Delivery> {
        return this.bus.receive(message);
    }
}

export interface HttpAuth {
    signer: string;
    key: KeyPair;
}

export interface HttpTransportOptions {
    endpoint: string;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    auth?: HttpAuth;
}

export interface WireAuth {
    signer: string;
    kid: string;
    timestamp: string;
    nonce: string;
    signature: string;
}

export interface CooperationHttpResponse {
    status: number;
    body: Delivery;
}

export interface CooperationHandlerOptions {
    keyring?: GovernanceKeyring;
    maxSkewMs?: number;
    replayWindowMs?: number;
    now?: () => number;
}

const isRecord: (value: unknown) => value is Record<string, unknown> = (value: unknown): value is Record<string, unknown> =>
    typeof(value) === "object" && value !== null && !Array.isArray(value);

const isDelivery: (value: unknown) => value is Delivery = (value: unknown): value is Delivery =>
    isRecord(value) && typeof(value.ok) === "boolean" && typeof(value.code) === "string" && typeof(value.detail) === "string";

/**
 * Nonce replay window. Entries expire after the window, so the guard does not
 * grow without bound.
 */
export class ReplayGuard {
    private readonly seen = new Map<string, number>();

    accept(nonce: string, now: number, windowMs: number): boolean {
        const entries: Array<[string, number]> = [...this.seen.entries()];
        for (let index: number = 0; index < entries.length; index += 1) {
            const key: string = entries[index][0];
            const expiry: number = entries[index][1];
            if (expiry <= now) {
                this.seen.delete(key);
            }
        }
        if (this.seen.has(nonce)) {
            return false;
        }
        this.seen.set(nonce, now + windowMs);
        return true;
    }
}

export class HttpCooperationTransport implements CooperationTransport {
    private readonly endpoint: string;
    private readonly fetchImpl: typeof fetch;
    private readonly timeoutMs: number;
    private readonly auth?: HttpAuth;

    constructor(options: HttpTransportOptions) {
        if (options.endpoint.length === 0) {
            throw new TypeError("HttpCooperationTransport requires an endpoint");
        }
        this.endpoint = options.endpoint;
        this.fetchImpl = options.fetchImpl ?? fetch;
        this.timeoutMs = options.timeoutMs ?? 15_000;
        this.auth = options.auth;
    }

    async deliver(message: AgentMessage): Promise<Delivery> {
        const controller: AbortController = new AbortController();
        const timer: ReturnType<typeof setTimeout> = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
            const auth: WireAuth | undefined =
                this.auth === (void 0)
                    ? undefined
                    : await (async (): Promise<WireAuth> => {
                          const timestamp: string = new Date().toISOString();
                          const nonce: string = crypto.randomUUID();
                          const signature: string = await signCanonicalValue(
                              { message, signer: this.auth?.signer, timestamp, nonce },
                              this.auth?.key as KeyPair,
                          );
                          return { signer: this.auth?.signer as string, kid: this.auth?.key.kid as string, timestamp, nonce, signature };
                      })();
            const response: Response = await this.fetchImpl(this.endpoint, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ message, ...(auth === (void 0) ? {} : { auth }) }),
                signal: controller.signal,
            });
            const parsed: unknown = await response.json();
            if (!isDelivery(parsed)) {
                return { ok: false, code: "transport-error", detail: `endpoint returned HTTP ${response.status} without a delivery` };
            }
            return parsed;
        } catch (error) {
            return { ok: false, code: "transport-error", detail: error instanceof Error ? error.message : `${error}` };
        } finally {
            clearTimeout(timer);
        }
    }
}

/**
 * Server-side handler. Malformed envelopes are 400, failed authentication 401,
 * replay or clock skew 409, policy rejections 422, success 200.
 */
type CooperationHandler = (body: unknown) => Promise<CooperationHttpResponse>;

type CreateCooperationHandler = (bus: CooperationBus, options?: CooperationHandlerOptions) => CooperationHandler;

export const createCooperationHandler: CreateCooperationHandler = (bus, options = {}) => {
    const replay: ReplayGuard = new ReplayGuard();
    const now: () => number = options.now ?? (() => Date.now());
    const maxSkewMs: number = Math.max(1_000, options.maxSkewMs ?? 60_000);
    const replayWindowMs: number = Math.max(maxSkewMs, options.replayWindowMs ?? 5 * 60_000);
    return async (body: unknown): Promise<CooperationHttpResponse> => {
        if (!isRecord(body) || !isRecord(body.message)) {
            return {
                status: 400,
                body: { ok: false, code: "manifest-invalid", detail: "expected { message: AgentMessage }" },
            };
        }
        if (options.keyring !== (void 0)) {
            const auth: unknown = body.auth;
            if (!isRecord(auth) || typeof(auth.signer) !== "string" || typeof(auth.signature) !== "string" || typeof(auth.timestamp) !== "string" || typeof(auth.nonce) !== "string") {
                return { status: 401, body: { ok: false, code: "transport-error", detail: "missing transport authentication" } };
            }
            const candidates: CryptoKey[] = options.keyring.candidates(auth.signer, auth.kid as string | undefined);
            if (candidates.length === 0) {
                return { status: 401, body: { ok: false, code: "transport-error", detail: `unknown or revoked transport signer ${auth.signer}` } };
            }
            const timestamp: number = Date.parse(auth.timestamp);
            const current: number = now();
            if (!Number.isFinite(timestamp) || Math.abs(current - timestamp) > maxSkewMs) {
                return { status: 409, body: { ok: false, code: "transport-error", detail: "transport timestamp is outside the allowed skew" } };
            }
            if (!replay.accept(auth.nonce, current, replayWindowMs)) {
                return { status: 409, body: { ok: false, code: "transport-error", detail: "transport nonce was already used" } };
            }
            let valid: boolean = false;
            for (let index: number = 0; index < candidates.length; index += 1) {
                if (await verifyCanonicalValue(
                    { message: body.message, signer: auth.signer, timestamp: auth.timestamp, nonce: auth.nonce },
                    auth.signature,
                    candidates[index],
                )) {
                    valid = true;
                    break;
                }
            }
            if (!valid) {
                return { status: 401, body: { ok: false, code: "transport-error", detail: "transport signature does not verify" } };
            }
        }
        const delivery: Delivery = bus.receive(body.message as unknown as AgentMessage);
        return { status: delivery.ok ? 200 : 422, body: delivery };
    };
};
