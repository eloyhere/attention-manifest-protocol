/**
 * The three-layer context (spec section 3).
 *
 *   - global core: goal, signed capability statement, hard constraints,
 *     priorities, budget, task state, versioned board strategy, scenario and
 *     mode labels. Every perspective reads it; only the board or a human
 *     writes it.
 *   - perspective-private context: the manifest, local reasoning, tool results
 *     and private budget. Only that perspective may read it, and switching
 *     seals it.
 *   - shared receipt blackboard: conclusions, evidence refs, confidence,
 *     budget spent, manifest version, scenario/mode labels, open questions and
 *     escalation requests. Each perspective writes only its own receipts.
 *
 * The default inheritance is the board strategy summary, not the whole board
 * context; `expandGlobal` opens the full record on demand.
 */
import type { Budget, Digest, Id, Ref, Timestamp } from "../types/common.ts";
import type { ApprovalGrant, EscalationRef, ManifestRef, ModeWeights, PerspectiveId, ScenarioId } from "./types.ts";
import { GovernanceError } from "./types.ts";
import { perspective } from "./perspectives.ts";
import { digestOf } from "../semantic/canonical.ts";

export interface StrategyView {
    version: number;
    digest: Digest;
    /**
     * What a perspective inherits by default.
     */
    summary: string;
    /**
     * The full board record, expanded only on demand.
     */
    detail: string;
}

export interface GlobalCore {
    goal: string;
    strategy: StrategyView;
    constraints: string[];
    priorities: string[];
    taskState: string;
    scenario: ScenarioId;
    modes: ModeWeights;
    budget: Budget;
    version: number;
}

/**
 * The read-only projection a perspective receives by default.
 */
export interface GlobalCoreView {
    goal: string;
    strategyVersion: number;
    strategyDigest: Digest;
    strategySummary: string;
    constraints: string[];
    priorities: string[];
    taskState: string;
    scenario: ScenarioId;
    modes: ModeWeights;
    budget: Budget;
    version: number;
}

export interface PrivateNote {
    at: Timestamp;
    kind: "reasoning" | "tool-result" | "observation";
    text: string;
    refs?: Ref[];
}

export interface PrivateContext {
    perspective: PerspectiveId;
    manifest: ManifestRef;
    notes: PrivateNote[];
    openedAt: Timestamp;
    sealed: boolean;
}

export interface BoardReceiptInput {
    conclusion: string;
    evidence: Ref[];
    confidence: number;
    budget: Budget;
    manifest: ManifestRef;
    scenario: ScenarioId;
    modes: ModeWeights;
    openQuestions?: string[];
    escalation?: EscalationRef;
    audience?: PerspectiveId[];
}

export interface BoardReceipt extends BoardReceiptInput {
    id: Id;
    from: PerspectiveId;
    at: Timestamp;
    digest: Digest;
    openQuestions: string[];
}

export interface ContextLayersOptions {
    core: GlobalCore;
    now: () => Timestamp;
}

export interface ContextSnapshot {
    core: GlobalCore;
    privateContexts: Array<{ perspective: PerspectiveId; notes: number; sealed: boolean; }>;
    receipts: BoardReceipt[];
    version: number;
}

const ReadersOfEverything: readonly PerspectiveId[] = ["general-manager", "board", "supervisory", "legal"];

export class ContextLayers {
    private core: GlobalCore;
    private readonly now: () => Timestamp;
    private readonly privateContexts = new Map<PerspectiveId, PrivateContext>();
    private readonly receipts: BoardReceipt[] = [];
    private active: PerspectiveId | undefined;
    private counter = 0;

    constructor(options: ContextLayersOptions) {
        if (typeof(options.now) !== "function") {
            throw new TypeError("ContextLayers requires a clock");
        }
        this.now = options.now;
        this.core = copyCore(options.core);
    }

    /**
     * The default view: summary only, no full board record.
     */
    global(viewer: PerspectiveId): GlobalCoreView {
        perspective(viewer);
        return {
            goal: this.core.goal,
            strategyVersion: this.core.strategy.version,
            strategyDigest: this.core.strategy.digest,
            strategySummary: this.core.strategy.summary,
            constraints: [...this.core.constraints],
            priorities: [...this.core.priorities],
            taskState: this.core.taskState,
            scenario: this.core.scenario,
            modes: { ...this.core.modes },
            budget: { ...this.core.budget },
            version: this.core.version,
        };
    }

    /**
     * Expand the full board record on demand. The access is not hidden: the
     * caller records it in its own receipt.
     */
    expandGlobal(viewer: PerspectiveId): GlobalCore {
        perspective(viewer);
        return copyCore(this.core);
    }

    /**
     * Only the board or a human may write the global core. The change bumps
     * the version so every perspective can detect that its assumption is stale.
     */
    writeGlobal(by: PerspectiveId | "human", patch: Partial<GlobalCore>, approval?: ApprovalGrant): GlobalCore {
        if (by !== "human" && by !== "board") {
            throw new GovernanceError("context-denied", `${by} may not write the global core`);
        }
        if (by === "board" && approval !== (void 0) && (approval.granted !== true || approval.subject !== "board.write" || approval.by !== "board")) {
            throw new GovernanceError("context-denied", "the board write approval is not valid");
        }
        this.core = copyCore({ ...this.core, ...patch, version: this.core.version + 1 });
        return copyCore(this.core);
    }

    /**
     * Open a perspective's private context and seal the previously active one.
     * The caller cannot keep reading the old view through this object.
     */
    openPerspective(id: PerspectiveId, manifest: ManifestRef): PrivateContext {
        if (this.active !== (void 0) && this.active !== id) {
            this.seal(this.active);
        }
        this.active = id;
        const existing: PrivateContext | undefined = this.privateContexts.get(id);
        if (existing !== (void 0)) {
            existing.manifest = { ...manifest };
            existing.sealed = false;
            return copyPrivate(existing);
        }
        const context: PrivateContext = {
            perspective: id,
            manifest: { ...manifest },
            notes: [],
            openedAt: this.now(),
            sealed: false,
        };
        this.privateContexts.set(id, context);
        return copyPrivate(context);
    }

    seal(id?: PerspectiveId): void {
        if (id === (void 0)) {
            return;
        }
        const context: PrivateContext | undefined = this.privateContexts.get(id);
        if (context !== (void 0)) {
            context.sealed = true;
        }
        if (this.active === id) {
            this.active = undefined;
        }
    }

    /**
     * Append a private note. Only the owner of an open context may write it.
     */
    writePrivate(id: PerspectiveId, note: PrivateNote): PrivateContext {
        const context: PrivateContext | undefined = this.privateContexts.get(id);
        if (context === (void 0) || context.sealed) {
            throw new GovernanceError("context-denied", `${id} has no open private context`);
        }
        if (this.active !== id) {
            throw new GovernanceError("context-denied", `${id} is not the active perspective`);
        }
        context.notes.push({ ...note, ...(note.refs === (void 0) ? {} : { refs: note.refs.map((ref: Ref) => ({ ...ref })) }) });
        return copyPrivate(context);
    }

    /**
     * Read a private context. Only the owner may read it, sealed or not.
     */
    readPrivate(id: PerspectiveId, viewer: PerspectiveId): PrivateContext | undefined {
        if (id !== viewer) {
            throw new GovernanceError("context-denied", `${viewer} may not read ${id}'s private context`);
        }
        const context: PrivateContext | undefined = this.privateContexts.get(id);
        return context === (void 0) ? undefined : copyPrivate(context);
    }

    /**
     * Write one receipt to the shared blackboard. The writer must be the active
     * perspective and the receipt must match its manifest version.
     */
    writeReceipt(from: PerspectiveId, input: BoardReceiptInput): BoardReceipt {
        if (this.active !== from) {
            throw new GovernanceError("context-denied", `${from} is not the active perspective`);
        }
        if (input.conclusion.trim().length === 0) {
            throw new GovernanceError("context-denied", "a receipt needs a conclusion");
        }
        if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) {
            throw new GovernanceError("context-denied", "confidence must be in [0, 1]");
        }
        const manifest: PrivateContext | undefined = this.privateContexts.get(from);
        if (manifest !== (void 0) && (manifest.manifest.id !== input.manifest.id || manifest.manifest.version !== input.manifest.version)) {
            throw new GovernanceError("manifest-version-conflict", `receipt cites ${input.manifest.id} v${input.manifest.version}`);
        }
        this.counter += 1;
        const unsigned: Omit<BoardReceipt, "digest"> = {
            id: `rcp.${this.counter}`,
            from,
            at: this.now(),
            conclusion: input.conclusion,
            evidence: input.evidence.map((ref: Ref) => ({ ...ref })),
            confidence: input.confidence,
            budget: { ...input.budget },
            manifest: { ...input.manifest },
            scenario: input.scenario,
            modes: { ...input.modes },
            openQuestions: [...(input.openQuestions ?? [])],
            ...(input.escalation === (void 0) ? {} : { escalation: { ...input.escalation } }),
            ...(input.audience === (void 0) ? {} : { audience: [...input.audience] }),
        };
        const receipt: BoardReceipt = { ...unsigned, digest: digestOf(unsigned) };
        this.receipts.push(receipt);
        return copyReceipt(receipt);
    }

    /**
     * The blackboard is not public: the management and audit perspectives see
     * everything, execution perspectives see their own receipts and receipts
     * addressed to them.
     */
    readReceipts(viewer: PerspectiveId): BoardReceipt[] {
        const all: boolean = ReadersOfEverything.includes(viewer);
        return this.receipts.filter((receipt: BoardReceipt) => all || receipt.from === viewer || (receipt.audience ?? []).includes(viewer)).map(copyReceipt);
    }

    readReceipt(id: Id, viewer: PerspectiveId): BoardReceipt | undefined {
        const receipt: BoardReceipt | undefined = this.receipts.find((entry: BoardReceipt) => entry.id === id);
        if (receipt === (void 0)) {
            return undefined;
        }
        const all: boolean = ReadersOfEverything.includes(viewer);
        if (!all && receipt.from !== viewer && !(receipt.audience ?? []).includes(viewer)) {
            throw new GovernanceError("context-denied", `${viewer} may not read ${id}`);
        }
        return copyReceipt(receipt);
    }

    /**
     * Receipts that requested escalation, used by the workflow's escalation
     * phase.
     */
    escalations(): BoardReceipt[] {
        return this.receipts.filter((receipt: BoardReceipt) => receipt.escalation !== (void 0)).map(copyReceipt);
    }

    snapshot(): ContextSnapshot {
        return {
            core: copyCore(this.core),
            privateContexts: [...this.privateContexts.values()].map((context: PrivateContext) => ({
                perspective: context.perspective,
                notes: context.notes.length,
                sealed: context.sealed,
            })),
            receipts: this.receipts.map(copyReceipt),
            version: this.core.version,
        };
    }
}

const copyCore: (core: GlobalCore) => GlobalCore = (core: GlobalCore): GlobalCore => ({
    goal: core.goal,
    strategy: { ...core.strategy },
    constraints: [...core.constraints],
    priorities: [...core.priorities],
    taskState: core.taskState,
    scenario: core.scenario,
    modes: { ...core.modes },
    budget: { ...core.budget },
    version: core.version,
});

const copyReceipt: (receipt: BoardReceipt) => BoardReceipt = (receipt: BoardReceipt): BoardReceipt => ({
    ...receipt,
    evidence: receipt.evidence.map((ref: Ref) => ({ ...ref })),
    budget: { ...receipt.budget },
    manifest: { ...receipt.manifest },
    modes: { ...receipt.modes },
    openQuestions: [...receipt.openQuestions],
    ...(receipt.escalation === (void 0) ? {} : { escalation: { ...receipt.escalation } }),
    ...(receipt.audience === (void 0) ? {} : { audience: [...receipt.audience] }),
});

const copyPrivate: (context: PrivateContext) => PrivateContext = (context: PrivateContext): PrivateContext => ({
    perspective: context.perspective,
    manifest: { ...context.manifest },
    notes: context.notes.map((note: PrivateNote) => ({
        ...note,
        ...(note.refs === (void 0) ? {} : { refs: note.refs.map((ref: Ref) => ({ ...ref })) }),
    })),
    openedAt: context.openedAt,
    sealed: context.sealed,
});
