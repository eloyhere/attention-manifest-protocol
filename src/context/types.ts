import type { Budget, BudgetUsage, Identifier } from "../shared.ts";
import type { AttentionPointer, AttentionScope } from "../attention/types.ts";

export type CompiledAttentionItem = {
    id: Identifier;
    summary: string;
    pointer: AttentionPointer;
    sources: readonly AttentionPointer[];
    version: number;
    sourceVersion: string;
    expiresAt: string;
    reason: string;
    budget: Budget;
    usage: BudgetUsage;
};

export type ContextExclusion = {
    id: Identifier;
    version: number;
    reason: "scope" | "expired" | "stale" | "unmounted" | "version" | "budget";
    pointer?: AttentionPointer;
};

export type CompileContextOptions = {
    now: string;
    scope: AttentionScope;
    budget: Budget;
    /** Required current domain versions; unknown versions are excluded. */
    currentVersion: (pointer: AttentionPointer) => string | undefined;
    /** Must match the eventual provider tokenizer; default is conservative UTF-8 bytes. */
    countTokens?: (serializedItem: string) => number;
};

export type CompiledContext = {
    version: "attention-context/1";
    compiledAt: string;
    scope: AttentionScope;
    items: readonly CompiledAttentionItem[];
    exclusions: readonly ContextExclusion[];
    budget: Budget;
    usage: BudgetUsage;
    /** Model payload only; exclusion/audit records stay outside the model request. */
    text: string;
    authorization: "not_granted";
};
