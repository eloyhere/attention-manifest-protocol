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

export const suggestPriorityTuning = (behaviors: readonly Behavior[], conflicts: Record<string, number>, options: TuningOptions = {}): PrioritySuggestion[] => {
    const threshold = options.threshold ?? 3;
    const maxDelta = options.maxDelta ?? 5;
    const byId = new Map(behaviors.map((behavior) => [behavior.id, behavior]));
    const deltas = new Map<string, { delta: number; reason: string[] }>();
    const add = (id: string, delta: number, reason: string): void => {
        const entry = deltas.get(id) ?? { delta: 0, reason: [] };
        entry.delta += delta;
        entry.reason.push(reason);
        deltas.set(id, entry);
    };

    for (const [key, count] of Object.entries(conflicts)) {
        if (count < threshold) continue;
        const [winnerId, loserId] = key.split("<-");
        const winner = byId.get(winnerId);
        const loser = byId.get(loserId);
        if (winner === undefined || loser === undefined) continue;
        add(winnerId, 1, `${winnerId} beat ${loserId} ${count}x`);
        if (loser.policy.hardGuardrail !== true) add(loserId, -1, `${loserId} lost to ${winnerId} ${count}x`);
    }

    const suggestions: PrioritySuggestion[] = [];
    for (const [id, entry] of deltas) {
        const behavior = byId.get(id);
        if (behavior === undefined) continue;
        const delta = Math.max(-maxDelta, Math.min(maxDelta, entry.delta));
        if (delta === 0) continue;
        suggestions.push({
            behaviorId: id,
            current: behavior.priority,
            suggested: Math.max(0, Math.min(100, behavior.priority + delta)),
            reason: entry.reason.join("; "),
        });
    }
    return suggestions.sort((left, right) => Math.abs(right.suggested - right.current) - Math.abs(left.suggested - left.current));
};

/** Return tuned copies; never mutate the registry's behavior list. */
export const applyPrioritySuggestions = (behaviors: readonly Behavior[], suggestions: readonly PrioritySuggestion[]): Behavior[] => {
    const byId = new Map(suggestions.map((suggestion) => [suggestion.behaviorId, suggestion]));
    return behaviors.map((behavior) => {
        const suggestion = byId.get(behavior.id);
        return suggestion === undefined ? behavior : { ...behavior, priority: suggestion.suggested };
    });
};

/** Restore the original priorities; the tuned list is not mutated. */
export const rollbackPrioritySuggestions = (tuned: readonly Behavior[], original: readonly Behavior[]): Behavior[] => {
    const byId = new Map(original.map((behavior) => [behavior.id, behavior]));
    return tuned.map((behavior) => {
        const source = byId.get(behavior.id);
        return source === undefined ? behavior : { ...behavior, priority: source.priority };
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

/** Opt-in controller: default is review-only; enabled applies bounded changes. */
export class BehaviorTuningController {
    private readonly registry: BehaviorRegistry;
    private lastSignature = "";

    constructor(registry: BehaviorRegistry) {
        this.registry = registry;
    }

    autoApply(conflicts: Record<string, number>, options: AutoTuneOptions): AutoTuneResult {
        const suggestions = suggestPriorityTuning(this.registry.list(), conflicts, { threshold: options.threshold });
        const signature = JSON.stringify(conflicts);
        if (!options.enabled || suggestions.length === 0 || signature === this.lastSignature) {
            return { suggestions, applied: 0, version: this.registry.tuning() };
        }
        const changes = Object.fromEntries(suggestions.map((suggestion) => [suggestion.behaviorId, suggestion.suggested]));
        const result = this.registry.applyPriorities(changes);
        this.lastSignature = signature;
        return { suggestions, applied: result.applied.length, version: result.version };
    }

    rollback(version: number): boolean {
        return this.registry.rollbackPriorities(version);
    }
}
