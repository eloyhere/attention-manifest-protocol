/**
 * Multi-agent cooperation (spec section 13).
 *
 * Perspectives become independent agents. What crosses an agent boundary is a
 * structured message: a manifest summary, refs, a credential reference, a
 * receipt summary and scenario/mode labels. Private reasoning, raw context and
 * full payloads stay inside the sender; the receiver validates the credential
 * before it reads anything.
 *
 * The bus also prunes the communication graph. A candidate is scored by its
 * posterior reliability times the information value of talking to it, so a
 * flaky agent is not consulted just because it is reachable.
 */
import type { Digest, Id, Ref, Timestamp } from "../types/common.ts";
import type { BetaBelief } from "../bayes/engine.ts";
import type { EvidenceFloor, ManifestRef, ModeWeights, PerspectiveId, ScenarioId, VerificationVerdict } from "./types.ts";
import { GovernanceError } from "./types.ts";
import type { AttentionManifest } from "./attentionManifest.ts";
import { verifyAttentionManifest } from "./attentionManifest.ts";
import type { CredentialVerdict, SwitchCredential } from "./credential.ts";
import { verifyCredential } from "./credential.ts";
import type { BudgetAccount } from "./budget.ts";
import type { LegalGate } from "./legal.ts";
import { betaMean } from "../bayes/engine.ts";
import { digestOf } from "../semantic/canonical.ts";

export interface ManifestSummary {
    id: Id;
    version: number;
    scenario: ScenarioId;
    modes: ModeWeights;
    evidenceFloor: EvidenceFloor;
    focus: number;
    digest: Digest;
}

export interface RegisteredAgent {
    agentId: Id;
    perspective: PerspectiveId;
    manifest: AttentionManifest;
    /**
     * The agent's own ledger, usually `scope: "agent"`.
     */
    budget: BudgetAccount;
    reliability: BetaBelief;
}

export type MessageKind = "manifest" | "task" | "receipt" | "escalation" | "audit-request";

export interface ReceiptSummary {
    conclusion: string;
    confidence: number;
    evidence: Ref[];
    manifest: ManifestRef;
}

export interface AgentMessageInput {
    from: Id;
    to: Id;
    kind: MessageKind;
    at: Timestamp;
    /**
     * One or two sentences. No private reasoning, no raw context.
     */
    summary?: string;
    refs?: Ref[];
    credential?: SwitchCredential;
    receipt?: ReceiptSummary;
    escalation?: { reason: string; evidence: Ref[]; target: PerspectiveId; };
}

export interface AgentMessage extends AgentMessageInput {
    id: Id;
    manifest: ManifestSummary;
    openQuestions?: string[];
    digest: Digest;
}

export type DeliveryCode = "delivered" | "unknown-sender" | "unknown-recipient" | "self-send" | "manifest-invalid" | "credential-missing" | "credential-invalid" | "scope-escape" | "payload-too-large" | "receipt-invalid" | "legal-blocked" | "transport-error";

export interface Delivery {
    ok: boolean;
    code: DeliveryCode;
    detail: string;
    message?: AgentMessage;
}

export interface RouteOptions {
    voi?: Record<Id, number>;
    limit?: number;
}

export interface ScoredCandidate {
    id: Id;
    score: number;
}

export interface CooperationOptions {
    now: () => Timestamp;
    legal?: LegalGate;
    /**
     * Maximum refs per message; a structured receipt replaces a payload.
     */
    maxRefs?: number;
    /**
     * Maximum characters in `summary`.
     */
    maxSummary?: number;
}

const Messages: ReadonlySet<string> = new Set<string>(["manifest", "task", "receipt", "escalation", "audit-request"]);

const DefaultMaxRefs: number = 16;
const DefaultMaxSummary: number = 280;

export const manifestSummaryOf: (manifest: AttentionManifest) => ManifestSummary = (manifest: AttentionManifest): ManifestSummary => ({
    id: manifest.id,
    version: manifest.version,
    scenario: manifest.scenario,
    modes: { ...manifest.modes },
    evidenceFloor: manifest.evidenceFloor,
    focus: manifest.focus.length,
    digest: manifest.digest,
});

type MessageDigest = (message: Omit<AgentMessage, "digest"> | AgentMessage) => Digest;

const messageDigest: MessageDigest = (message) => {
    const body: Record<string, unknown> = { ...message };
    delete body.digest;
    return digestOf(body);
};

/**
 * Verify a message digest after transport.
 */
export const verifyAgentMessage: (message: AgentMessage) => boolean = (message: AgentMessage): boolean => messageDigest(message) === message.digest;

export class CooperationBus {
    private readonly now: () => Timestamp;
    private readonly legal?: LegalGate;
    private readonly maxRefs: number;
    private readonly maxSummary: number;
    private readonly agents = new Map<Id, RegisteredAgent>();
    private readonly inboxes = new Map<Id, AgentMessage[]>();
    private readonly seen = new Set<Id>();
    private readonly board: AgentMessage[] = [];
    private counter = 0;

    constructor(options: CooperationOptions) {
        if (typeof(options.now) !== "function") {
            throw new TypeError("CooperationBus requires a clock");
        }
        this.now = options.now;
        this.legal = options.legal;
        this.maxRefs = options.maxRefs ?? DefaultMaxRefs;
        this.maxSummary = options.maxSummary ?? DefaultMaxSummary;
    }

    register(agent: RegisteredAgent): void {
        if (this.agents.has(agent.agentId)) {
            throw new GovernanceError("registry-invalid", `${agent.agentId} is already registered`);
        }
        this.agents.set(agent.agentId, {
            ...agent,
            manifest: agent.manifest,
            reliability: { ...agent.reliability },
            budget: { ...agent.budget },
        });
        this.inboxes.set(agent.agentId, []);
    }

    /**
     * Replace an agent's manifest after a legitimate re-derivation.
     */
    refresh(agentId: Id, manifest: AttentionManifest): void {
        const agent: RegisteredAgent | undefined = this.agents.get(agentId);
        if (agent === (void 0)) {
            throw new GovernanceError("registry-invalid", `${agentId} is not registered`);
        }
        agent.manifest = manifest;
    }

    unregister(agentId: Id): boolean {
        this.inboxes.delete(agentId);
        return this.agents.delete(agentId);
    }

    agent(agentId: Id): RegisteredAgent | undefined {
        const found: RegisteredAgent | undefined = this.agents.get(agentId);
        return found === (void 0) ? undefined : { ...found, manifest: found.manifest, reliability: { ...found.reliability }, budget: { ...found.budget } };
    }

    agentsOf(perspective: PerspectiveId): RegisteredAgent[] {
        return [...this.agents.values()].filter((agent: RegisteredAgent) => agent.perspective === perspective);
    }

    /**
     * Broadcast a manifest summary. This is the only message that needs no
     * credential: it contains no payload and no private context.
     */
    announce(from: Id, at: Timestamp): Delivery[] {
        const deliveries: Delivery[] = [];
        const ids: Id[] = [...this.agents.keys()];
        for (let index: number = 0; index < ids.length; index += 1) {
            const to: Id = ids[index];
            if (to === from) {
                continue;
            }
            deliveries.push(this.send({ from, to, kind: "manifest", at }));
        }
        return deliveries;
    }

    /**
     * Send one structured message. The sender's manifest and, for task or
     * escalation messages, the credential are validated before delivery.
     */
    send(input: AgentMessageInput): Delivery {
        const sender: RegisteredAgent | undefined = this.agents.get(input.from);
        if (sender === (void 0)) {
            return { ok: false, code: "unknown-sender", detail: `${input.from} is not registered` };
        }
        const recipient: RegisteredAgent | undefined = this.agents.get(input.to);
        if (recipient === (void 0)) {
            return { ok: false, code: "unknown-recipient", detail: `${input.to} is not registered` };
        }
        if (input.from === input.to) {
            return { ok: false, code: "self-send", detail: "an agent cannot message itself" };
        }
        if (this.legal !== (void 0) && (this.legal.isBlocked() || this.legal.isFrozen(sender.perspective))) {
            return { ok: false, code: "legal-blocked", detail: "the sender is frozen or the breaker is active" };
        }
        const verdict: VerificationVerdict = verifyAttentionManifest(sender.manifest, input.at);
        if (!verdict.ok) {
            return { ok: false, code: "manifest-invalid", detail: verdict.detail ?? "sender manifest is not valid" };
        }
        if (input.summary !== (void 0) && input.summary.length > this.maxSummary) {
            return { ok: false, code: "payload-too-large", detail: `summary exceeds ${this.maxSummary} characters` };
        }
        const refs: Ref[] = input.refs ?? [];
        if (refs.length > this.maxRefs) {
            return { ok: false, code: "payload-too-large", detail: `more than ${this.maxRefs} refs` };
        }
        if (input.kind === "task" || input.kind === "escalation") {
            if (input.credential === (void 0)) {
                return { ok: false, code: "credential-missing", detail: `${input.kind} messages need a switch credential` };
            }
            const checked: CredentialVerdict = verifyCredential(input.credential, {
                at: input.at,
                to: recipient.perspective,
                manifest: { id: recipient.manifest.id, version: recipient.manifest.version },
                readRefs: refs,
            });
            if (!checked.valid) {
                return {
                    ok: false,
                    code: checked.code === "credential-scope" ? "scope-escape" : "credential-invalid",
                    detail: `${checked.code}: ${checked.detail}`,
                };
            }
        }
        if (input.kind === "receipt") {
            if (input.receipt === (void 0) || input.receipt.conclusion.trim().length === 0 || input.receipt.confidence < 0 || input.receipt.confidence > 1) {
                return { ok: false, code: "receipt-invalid", detail: "a receipt needs a conclusion and confidence in [0, 1]" };
            }
            if (input.receipt.manifest.id !== sender.manifest.id || input.receipt.manifest.version !== sender.manifest.version) {
                return { ok: false, code: "receipt-invalid", detail: "the receipt cites a different manifest version" };
            }
        }
        if (input.kind === "audit-request" && recipient.perspective !== "supervisory") {
            return { ok: false, code: "credential-invalid", detail: "audit requests go to the supervisory perspective" };
        }
        this.counter += 1;
        const body: Omit<AgentMessage, "digest"> = {
            id: `msg.${this.counter}`,
            from: input.from,
            to: input.to,
            kind: input.kind,
            at: input.at,
            manifest: manifestSummaryOf(sender.manifest),
            ...(input.summary === (void 0) ? {} : { summary: input.summary }),
            ...(refs.length === 0 ? {} : { refs: refs.map((ref: Ref) => ({ ...ref })) }),
            ...(input.credential === (void 0) ? {} : { credential: input.credential }),
            ...(input.receipt === (void 0) ? {} : { receipt: { ...input.receipt, evidence: input.receipt.evidence.map((ref: Ref) => ({ ...ref })) } }),
            ...(input.escalation === (void 0) ? {} : { escalation: { ...input.escalation, evidence: input.escalation.evidence.map((ref: Ref) => ({ ...ref })) } }),
        };
        const message: AgentMessage = { ...body, digest: messageDigest(body) };
        const inbox: AgentMessage[] = this.inboxes.get(input.to) ?? [];
        inbox.push(message);
        this.inboxes.set(input.to, inbox);
        this.seen.add(message.id);
        this.board.push(message);
        return { ok: true, code: "delivered", detail: `${message.id} delivered`, message };
    }

    /**
     * Admit a message that arrived over a transport. The receiver re-verifies
     * the digest, the sender's current manifest, the credential and the receipt
     * version before the message enters the inbox.
     */
    receive(message: AgentMessage): Delivery {
        const sender: RegisteredAgent | undefined = this.agents.get(message.from);
        if (sender === (void 0)) {
            return { ok: false, code: "unknown-sender", detail: `${message.from} is not registered` };
        }
        const recipient: RegisteredAgent | undefined = this.agents.get(message.to);
        if (recipient === (void 0)) {
            return { ok: false, code: "unknown-recipient", detail: `${message.to} is not registered` };
        }
        if (message.from === message.to) {
            return { ok: false, code: "self-send", detail: "an agent cannot message itself" };
        }
        if (!Messages.has(message.kind)) {
            return { ok: false, code: "manifest-invalid", detail: `${`${message.kind}`} is not a message kind` };
        }
        if (!verifyAgentMessage(message)) {
            return { ok: false, code: "manifest-invalid", detail: "message digest does not match" };
        }
        if (message.manifest.id !== sender.manifest.id || message.manifest.version !== sender.manifest.version) {
            return { ok: false, code: "manifest-invalid", detail: "the message cites a stale manifest version" };
        }
        if (this.legal !== (void 0) && (this.legal.isBlocked() || this.legal.isFrozen(sender.perspective))) {
            return { ok: false, code: "legal-blocked", detail: "the sender is frozen or the breaker is active" };
        }
        const verdict: VerificationVerdict = verifyAttentionManifest(sender.manifest, message.at);
        if (!verdict.ok) {
            return { ok: false, code: "manifest-invalid", detail: verdict.detail ?? "sender manifest is not valid" };
        }
        if (message.summary !== (void 0) && message.summary.length > this.maxSummary) {
            return { ok: false, code: "payload-too-large", detail: `summary exceeds ${this.maxSummary} characters` };
        }
        const refs: Ref[] = message.refs ?? [];
        if (refs.length > this.maxRefs) {
            return { ok: false, code: "payload-too-large", detail: `more than ${this.maxRefs} refs` };
        }
        if (message.kind === "task" || message.kind === "escalation") {
            if (message.credential === (void 0)) {
                return { ok: false, code: "credential-missing", detail: `${message.kind} messages need a switch credential` };
            }
            const checked: CredentialVerdict = verifyCredential(message.credential, {
                at: message.at,
                to: recipient.perspective,
                manifest: { id: recipient.manifest.id, version: recipient.manifest.version },
                readRefs: refs,
            });
            if (!checked.valid) {
                return {
                    ok: false,
                    code: checked.code === "credential-scope" ? "scope-escape" : "credential-invalid",
                    detail: `${checked.code}: ${checked.detail}`,
                };
            }
        }
        if (message.kind === "receipt") {
            if (message.receipt === (void 0) || message.receipt.conclusion.trim().length === 0 || message.receipt.confidence < 0 || message.receipt.confidence > 1) {
                return { ok: false, code: "receipt-invalid", detail: "a receipt needs a conclusion and confidence in [0, 1]" };
            }
            if (message.receipt.manifest.id !== sender.manifest.id || message.receipt.manifest.version !== sender.manifest.version) {
                return { ok: false, code: "receipt-invalid", detail: "the receipt cites a different manifest version" };
            }
        }
        if (message.kind === "audit-request" && recipient.perspective !== "supervisory") {
            return { ok: false, code: "credential-invalid", detail: "audit requests go to the supervisory perspective" };
        }
        if (this.seen.has(message.id)) {
            return { ok: true, code: "delivered", detail: `${message.id} duplicate ignored`, message };
        }
        this.seen.add(message.id);
        const inbox: AgentMessage[] = this.inboxes.get(message.to) ?? [];
        inbox.push(message);
        this.inboxes.set(message.to, inbox);
        this.board.push(message);
        return { ok: true, code: "delivered", detail: `${message.id} received`, message };
    }


    inbox(agentId: Id, at: Timestamp): Delivery[] {
        const agent: RegisteredAgent | undefined = this.agents.get(agentId);
        if (agent === (void 0)) {
            throw new GovernanceError("registry-invalid", `${agentId} is not registered`);
        }
        const messages: AgentMessage[] = this.inboxes.get(agentId) ?? [];
        return messages.map((message: AgentMessage) => {
            if (!verifyAgentMessage(message)) {
                return { ok: false, code: "manifest-invalid", detail: "message digest does not match" };
            }
            if (message.credential !== (void 0)) {
                const checked: CredentialVerdict = verifyCredential(message.credential, {
                    at,
                    to: agent.perspective,
                    manifest: { id: agent.manifest.id, version: agent.manifest.version },
                });
                if (!checked.valid) {
                    return { ok: false, code: "credential-invalid", detail: `${checked.code}: ${checked.detail}` };
                }
            }
            return { ok: true, code: "delivered", detail: message.id, message };
        });
    }

    /**
     * Prune the communication graph: reliability x information value.
     */
    route(from: Id, candidates: readonly Id[], options: RouteOptions = {}): Id[] {
        const limit: number = Math.max(0, options.limit ?? 3);
        const scored: ScoredCandidate[] = [];
        for (let index: number = 0; index < candidates.length; index += 1) {
            const id: Id = candidates[index];
            if (id === from) {
                continue;
            }
            const agent: RegisteredAgent | undefined = this.agents.get(id);
            if (agent === (void 0)) {
                continue;
            }
            const value: number = Math.max(0, options.voi?.[id] ?? 0);
            scored.push({ id, score: betaMean(agent.reliability) * (1 + value) });
        }
        scored.sort((left: ScoredCandidate, right: ScoredCandidate) => right.score - left.score || left.id.localeCompare(right.id));
        return scored.slice(0, limit).map((entry: ScoredCandidate) => entry.id);
    }

    /**
     * Update a recipient's reliability from an observed outcome.
     */
    observe(agentId: Id, success: boolean, weight: number = 1): BetaBelief {
        const agent: RegisteredAgent | undefined = this.agents.get(agentId);
        if (agent === (void 0)) {
            throw new GovernanceError("registry-invalid", `${agentId} is not registered`);
        }
        const delta: number = Math.max(0, weight);
        agent.reliability = {
            alpha: agent.reliability.alpha + (success ? delta : 0),
            beta: agent.reliability.beta + (success ? 0 : delta),
        };
        return { ...agent.reliability };
    }

    /**
     * The shared, structured board. It contains message summaries, not private
     * reasoning, so supervisory audit can read it without inheriting execution
     * context.
     */
    boardEntries(): AgentMessage[] {
        return this.board.map((message: AgentMessage) => message);
    }

    /**
     * An independent audit request: evidence refs only, no receipt body and no
     * private context. The supervisory agent can trace by reference.
     */
    auditRequest(from: Id, evidence: readonly Ref[], at: Timestamp): Delivery {
        const supervisory: RegisteredAgent | undefined = [...this.agents.values()].find((agent: RegisteredAgent) => agent.perspective === "supervisory");
        if (supervisory === (void 0)) {
            return { ok: false, code: "unknown-recipient", detail: "no supervisory agent is registered" };
        }
        return this.send({ from, to: supervisory.agentId, kind: "audit-request", at, refs: [...evidence], summary: "independent evidence audit" });
    }

    /**
     * Convenience: hand a task to a target with a credential.
     */
    handoff(from: Id, to: Id, credential: SwitchCredential, refs: readonly Ref[], at: Timestamp, summary?: string): Delivery {
        return this.send({
            from,
            to,
            kind: "task",
            at,
            credential,
            refs: [...refs],
            ...(summary === (void 0) ? {} : { summary }),
        });
    }

    nowValue(): Timestamp {
        return this.now();
    }
}
