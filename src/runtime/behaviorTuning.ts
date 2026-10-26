/**
 * Conservative behavior-priority suggestions from conflict statistics.
 *
 * This never mutates a registry automatically: it emits a proposal that a human
 * can review. Hard guardrails are never decreased.
 */
import type { Behavior } from "./behavior.ts";
import type { BehaviorRegistry } from "./behavior.ts";

export interface PrioritySuggestion {
    behaviorId: string;
    current: number;
    suggested: number;
    reason: string;
}

export interface TuningOptions {
    threshold?: number;
    maxDelta?: number;
}

/**
 * Accumulated priority change for one behavior, with the reasons behind it.
 */
type DeltaEntry = {
    delta: number;
    reason: string[];
};

/**
 * Signature of the review-only tuning suggester.
 */
type TuningSuggester = (behaviors: readonly Behavior[], conflicts: Record<string, number>, options?: TuningOptions) => PrioritySuggestion[];

export const suggestPriorityTuning: TuningSuggester = (behaviors: readonly Behavior[], conflicts: Record<string, number>, options: TuningOptions = {}) => {
    const threshold: number = options.threshold ?? 3;
    const maxDelta: number = options.maxDelta ?? 5;
    const byId: Map<string, Behavior> = new Map(behaviors.map((behavior): [string, Behavior] => [behavior.id, behavior]));
    const deltas: Map<string, DeltaEntry> = new Map<string, DeltaEntry>();
    const add: (id: string, delta: number, reason: string) => void = (id: string, delta: number, reason: string): void => {
        const entry: DeltaEntry = deltas.get(id) ?? { delta: 0, reason: [] };
        entry.delta += delta;
        entry.reason.push(reason);
        deltas.set(id, entry);
    };

    const conflictEntries: [string, number][] = Object.entries(conflicts);
    for (let index: number = 0; index < conflictEntries.length; index += 1) {
        const [key, count]: [string, number] = conflictEntries[index];
        if (count < threshold) {
            continue;
        }
        const parts: string[] = key.split("<-");
        const winnerId: string = parts[0];
        const loserId: string = parts[1];
        const winner: Behavior | undefined = byId.get(winnerId);
        const loser: Behavior | undefined = byId.get(loserId);
        if (winner === (void 0) || loser === (void 0)) {
            continue;
        }
        add(winnerId, 1, `${winnerId} beat ${loserId} ${count}x`);
        if (loser.policy.hardGuardrail !== true) {
            add(loserId, -1, `${loserId} lost to ${winnerId} ${count}x`);
        }
    }

    const suggestions: PrioritySuggestion[] = [];
    const deltaEntries: [string, DeltaEntry][] = [...deltas];
    for (let index: number = 0; index < deltaEntries.length; index += 1) {
        const [id, entry]: [string, DeltaEntry] = deltaEntries[index];
        const behavior: Behavior | undefined = byId.get(id);
        if (behavior === (void 0)) {
            continue;
        }
        const delta: number = Math.max(-maxDelta, Math.min(maxDelta, entry.delta));
        if (delta === 0) {
            continue;
        }
        suggestions.push({
            behaviorId: id,
            current: behavior.priority,
            suggested: Math.max(0, Math.min(100, behavior.priority + delta)),
            reason: entry.reason.join("; "),
        });
    }
    return suggestions.sort((left, right) => Math.abs(right.suggested - right.current) - Math.abs(left.suggested - left.current));
};

/**
 * Signature of the reviewed-priority applier.
 */
type SuggestionsApplier = (behaviors: readonly Behavior[], suggestions: readonly PrioritySuggestion[]) => Behavior[];

/**
 * Return tuned copies; never mutate the registry's behavior list.
 */
export const applyPrioritySuggestions: SuggestionsApplier = (behaviors: readonly Behavior[], suggestions: readonly PrioritySuggestion[]) => {
    const byId: Map<string, PrioritySuggestion> = new Map(suggestions.map((suggestion): [string, PrioritySuggestion] => [suggestion.behaviorId, suggestion]));
    return behaviors.map((behavior) => {
        const suggestion: PrioritySuggestion | undefined = byId.get(behavior.id);
        return suggestion === (void 0) ? behavior : { ...behavior, priority: suggestion.suggested };
    });
};

/**
 * Signature of the rollback helper.
 */
type SuggestionsRollback = (tuned: readonly Behavior[], original: readonly Behavior[]) => Behavior[];

/**
 * Restore the original priorities; the tuned list is not mutated.
 */
export const rollbackPrioritySuggestions: SuggestionsRollback = (tuned: readonly Behavior[], original: readonly Behavior[]) => {
    const byId: Map<string, Behavior> = new Map(original.map((behavior): [string, Behavior] => [behavior.id, behavior]));
    return tuned.map((behavior) => {
        const source: Behavior | undefined = byId.get(behavior.id);
        return source === (void 0) ? behavior : { ...behavior, priority: source.priority };
    });
};

export interface AutoTuneOptions {
    enabled: boolean;
    threshold?: number;
}

export interface AutoTuneResult {
    suggestions: PrioritySuggestion[];
    applied: number;
    version: number;
}

/**
 * Outcome of applying reviewed priorities.
 */
type PriorityApplyResult = ReturnType<BehaviorRegistry["applyPriorities"]>;

/**
 * Opt-in controller: default is review-only; enabled applies bounded changes.
 */
export class BehaviorTuningController {
    private readonly registry: BehaviorRegistry;
    private lastSignature = "";

    constructor(registry: BehaviorRegistry) {
        this.registry = registry;
    }

    autoApply(conflicts: Record<string, number>, options: AutoTuneOptions): AutoTuneResult {
        const suggestions: PrioritySuggestion[] = suggestPriorityTuning(this.registry.list(), conflicts, { threshold: options.threshold });
        const signature: string = JSON.stringify(conflicts);
        if (!options.enabled || suggestions.length === 0 || signature === this.lastSignature) {
            return { suggestions, applied: 0, version: this.registry.tuning() };
        }
        const changes: Record<string, number> = Object.fromEntries(suggestions.map((suggestion) => [suggestion.behaviorId, suggestion.suggested]));
        const result: PriorityApplyResult = this.registry.applyPriorities(changes);
        this.lastSignature = signature;
        return { suggestions, applied: result.applied.length, version: result.version };
    }

    rollback(version: number): boolean {
        return this.registry.rollbackPriorities(version);
    }
}
