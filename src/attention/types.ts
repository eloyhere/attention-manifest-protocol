import type { SynchronousMapContract } from "semantic-typescript";
import type { Budget, BudgetUsage, Identifier } from "../shared.ts";

/** A pointer is a reference to a domain owner's fact, never an authorization. */
export type AttentionPointer = {
    kind: string;
    id: Identifier;
    version: string;
    uri?: string;
    digest?: string;
};

export type AttentionScope = {
    tenantId: Identifier;
    principalId: Identifier;
    sessionId: Identifier;
    turnId: Identifier;
    workspaceId?: Identifier;
    projectId?: Identifier;
};

export type AttentionScores = {
    relevance: number;
    urgency: number;
    confidence: number;
    importance: number;
};

export type AttentionRetention = {
    across: "steps" | "turns";
    reason: string;
    expiresAt: string;
    budget: Budget;
};

export type AttentionAssessment = {
    verifier: AttentionPointer;
    assessedAt: string;
    objectVersion: number;
    sourceVersion: string;
    posterior: number;
    evidence: readonly AttentionPointer[];
    recommendation: "retain" | "review" | "suppress";
    reason: string;
    /** L3 assessment is never a Goal/Task/business verification. */
    businessVerified: false;
};

export type AttentionObject = {
    id: Identifier;
    version: number;
    summary: string;
    pointer: AttentionPointer;
    sources: readonly AttentionPointer[];
    references: {
        evidence: readonly AttentionPointer[];
        receipts: readonly AttentionPointer[];
        capabilities: readonly AttentionPointer[];
        behaviors: readonly AttentionPointer[];
    };
    scope: AttentionScope;
    scores: AttentionScores;
    intensity: number;
    mounted: boolean;
    budget: Budget;
    expiresAt: string;
    stale: boolean;
    retention?: AttentionRetention;
    assessment?: AttentionAssessment;
    createdAt: string;
    updatedAt: string;
    lastReason: string;
};

export type CreateAttentionInput = {
    id: Identifier;
    summary: string;
    pointer: AttentionPointer;
    sources?: readonly AttentionPointer[];
    references?: Partial<AttentionObject["references"]>;
    scope: AttentionScope;
    scores?: Partial<AttentionScores>;
    budget: Budget;
    expiresAt: string;
    reason: string;
};

export type AttentionOperationOptions = {
    expectedVersion: number;
    now: string;
    reason: string;
};

export type AttentionUpdate = {
    summary?: string;
    pointer?: AttentionPointer;
    sources?: readonly AttentionPointer[];
    references?: Partial<AttentionObject["references"]>;
    scores?: Partial<AttentionScores>;
    budget?: Budget;
    expiresAt?: string;
    stale?: boolean;
};

export type AttentionVerificationInput = {
    verifier: AttentionPointer;
    sourceVersion: string;
    posterior: number;
    evidence: readonly AttentionPointer[];
    recommendation: AttentionAssessment["recommendation"];
};

export type AssociationLink = { id: Identifier; reason: string; cost?: Budget };
export type AssociationCandidate = {
    object: AttentionObject;
    via: Identifier;
    depth: number;
    reason: string;
    authorization: "not_granted";
};

export type AssociationOptions = {
    now: string;
    scope: AttentionScope;
    maxDepth: number;
    maxCandidates: number;
    maxVisited: number;
    budget: Budget;
    /** Supply only a policy-filtered index. This module never reads a resource. */
    objects: readonly AttentionObject[];
    links: Pick<SynchronousMapContract<Identifier, readonly AssociationLink[]>, "get">;
};

export type AssociationResult = {
    candidates: readonly AssociationCandidate[];
    visited: readonly Identifier[];
    usage: BudgetUsage;
    budget: Budget;
    stoppedBy: "complete" | "depth" | "candidates" | "visited" | "budget";
    authorization: "not_granted";
};

/** Compatibility type exports; context owns the compiled payload contract. */
export type { CompiledAttentionItem, ContextExclusion, CompileContextOptions, CompiledContext } from "../context/types.ts";
