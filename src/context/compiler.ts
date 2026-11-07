import { Optional, useFrom, useSynchronousToArray, useSynchronousToOrderedMap } from "semantic-typescript";
import { EmptyBudgetUsage, exceedsBudget } from "../shared.ts";
import type { BudgetUsage } from "../shared.ts";
import type { AttentionObject } from "../attention/types.ts";
import type { CompileContextOptions, CompiledAttentionItem, CompiledContext, ContextExclusion } from "./types.ts";
import { AttentionError, inScope, isExpired, timestamp, validateBudget, validateObject, validateScope } from "../attention/validation.ts";
import { safeStringify } from "../serialization/index.ts";

export function attentionPriority(object: AttentionObject): number {
    return object.intensity + object.scores.relevance + object.scores.urgency + object.scores.importance + object.scores.confidence;
}

/**
 * Compiles a model payload from references/summary metadata only. No renderer,
 * source fetch, business state transition, authorization or budget settlement.
 * Excluded large summaries keep retrievable pointers in the separate audit output.
 */
export function compileContext(objects: readonly AttentionObject[], options: CompileContextOptions): CompiledContext {
    validateScope(options.scope);
    validateBudget(options.budget);
    timestamp(options.now);
    if (Optional.ofNullable(options.budget.tokens).isEmpty() && Optional.ofNullable(options.budget.bytes).isEmpty()) {
        throw new AttentionError("invalid", "Context compilation needs a tokens or bytes limit");
    }
    const encoder = new TextEncoder();
    const countTokens = Optional.ofNullable(options.countTokens).get((text: string) => encoder.encode(text).byteLength);
    const started = performance.now();
    const exclusions: ContextExclusion[] = [];
    const items: CompiledAttentionItem[] = [];
    const lines: string[] = [];
    let usage = { ...EmptyBudgetUsage };
    // Reject duplicate projections rather than silently choosing a conflicting version.
    const index = useFrom(objects).toCollectable().collect(useSynchronousToOrderedMap(object => object.id));
    if (index.size() !== BigInt(objects.length)) throw new AttentionError("invalid", "Duplicate attention IDs in compilation");
    const ordered = useFrom(index.values()).toOrdered((left, right) =>
        attentionPriority(right) - attentionPriority(left) || left.id.localeCompare(right.id)
    ).collect(useSynchronousToArray());
    for (const object of ordered) {
        validateObject(object);
        const exclude = (reason: ContextExclusion["reason"]): void => {
            exclusions.push({ id: object.id, version: object.version, reason,
                ...(reason === "scope" ? {} : { pointer: structuredClone(object.pointer) }) });
        };
        if (!inScope(object, options.scope, options.now)) { exclude("scope"); continue; }
        if (isExpired(object, options.now)) { exclude("expired"); continue; }
        if (object.stale) { exclude("stale"); continue; }
        if (!object.mounted) { exclude("unmounted"); continue; }
        const pointers = [object.pointer, ...object.sources, ...Object.values(object.references).flat()];
        if (pointers.some(pointer => !Optional.ofNullable(options.currentVersion(structuredClone(pointer)))
            .map(version => version === pointer.version).get(false))) {
            exclude("version"); continue;
        }
        const projection = {
            id: object.id, summary: object.summary, pointer: object.pointer,
            sources: object.sources, version: object.version,
            sourceVersion: object.pointer.version, expiresAt: object.expiresAt,
            reason: object.lastReason, budget: object.budget,
        };
        // Projections are model payloads: a circular pointer must not abort the
        // whole compilation, so serialize through the cycle-safe helper.
        const serialized = safeStringify(projection);
        const tokens = countTokens(serialized);
        if (!Number.isSafeInteger(tokens) || tokens < 0) throw new AttentionError("invalid", "Tokenizer returned invalid token count");
        const itemUsage: BudgetUsage = {
            ...EmptyBudgetUsage, tokens, bytes: encoder.encode(serialized).byteLength,
        };
        const text = [...lines, serialized].join("\n");
        const totalTokens = countTokens(text);
        if (!Number.isSafeInteger(totalTokens) || totalTokens < 0) throw new AttentionError("invalid", "Tokenizer returned invalid token count");
        const nextUsage: BudgetUsage = {
            tokens: totalTokens,
            bytes: encoder.encode(text).byteLength,
            milliseconds: performance.now() - started,
            calls: 0,
        };
        const retentionOverBudget = Optional.ofNullable(object.retention)
            .filter(retention => timestamp(retention.expiresAt) > timestamp(options.now))
            .map(retention => exceedsBudget(itemUsage, retention.budget)).get(false);
        if (exceedsBudget(itemUsage, object.budget)
            || retentionOverBudget
            || exceedsBudget(nextUsage, options.budget)) {
            exclude("budget"); continue;
        }
        items.push({ ...structuredClone(projection), usage: itemUsage });
        lines.push(serialized);
        usage = nextUsage;
    }
    return {
        version: "attention-context/1", compiledAt: options.now, scope: { ...options.scope },
        items, exclusions, budget: { ...options.budget }, usage,
        text: lines.join("\n"), authorization: "not_granted",
    };
}
