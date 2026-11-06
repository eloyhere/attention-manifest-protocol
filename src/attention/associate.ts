import { Optional, SynchronousOrderedMap, SynchronousOrderedSet, useFrom, useSynchronousToOrderedMap } from "semantic-typescript";
import { addBudgetUsage, EmptyBudgetUsage, exceedsBudget } from "../shared.ts";
import type { AssociationCandidate, AssociationOptions, AssociationResult, AttentionObject } from "./types.ts";
import { AttentionError, inScope, isExpired, requireText, timestamp, validateBudget, validateObject, validateScope } from "./validation.ts";

/** Bounded BFS over a supplied, policy-filtered graph. Produces suggestions only. */
export function associate(root: AttentionObject, options: AssociationOptions): AssociationResult {
    validateObject(root);
    validateScope(options.scope);
    timestamp(options.now);
    validateBudget(options.budget);
    for (const [key, value] of Object.entries({ maxDepth: options.maxDepth, maxCandidates: options.maxCandidates, maxVisited: options.maxVisited })) {
        if (!Number.isSafeInteger(value) || value < 0) throw new AttentionError("invalid", `${key} must be a nonnegative integer`);
    }
    if (options.maxVisited < 1) throw new AttentionError("invalid", "maxVisited must include the root");
    if (Optional.ofNullable(options.budget.calls).isEmpty()) throw new AttentionError("invalid", "Association requires a calls budget (one per inspected edge)");
    const index = useFrom(options.objects).toCollectable().collect(useSynchronousToOrderedMap(object => object.id));
    if (index.size() !== BigInt(options.objects.length)) throw new AttentionError("invalid", "Duplicate attention IDs in index");
    const visited = new SynchronousOrderedSet<string>();
    const queue = new SynchronousOrderedMap<number, { object: AttentionObject; depth: number }>();
    const candidates: AssociationCandidate[] = [];
    let usage = { ...EmptyBudgetUsage };
    let stoppedBy: AssociationResult["stoppedBy"] = "complete";
    const started = performance.now();
    const finish = (): AssociationResult => ({
        candidates, visited: visited.toArray(), usage,
        budget: { ...options.budget }, stoppedBy, authorization: "not_granted",
    });
    if (!inScope(root, options.scope, options.now) || root.stale || isExpired(root, options.now)) return finish();
    visited.add(root.id);
    queue.put(0, { object: root, depth: 0 });
    let head = 0;
    let tail = 1;
    while (head < tail) {
        const current = queue.get(head).get();
        queue.remove(head++);
        const links = options.links.get(current.object.id).get([]);
        if (current.depth >= options.maxDepth) {
            if (links.length > 0 && stoppedBy === "complete") stoppedBy = "depth";
            continue;
        }
        for (const link of links) {
            if (candidates.length >= options.maxCandidates) { stoppedBy = "candidates"; return finish(); }
            if (Number(visited.size()) >= options.maxVisited) { stoppedBy = "visited"; return finish(); }
            requireText(link.reason, "association.reason");
            const cost = Optional.ofNullable(link.cost).get({});
            validateBudget(cost);
            const nextUsage = addBudgetUsage(usage, { ...cost, calls: Math.max(1, Optional.ofNullable(cost.calls).get(0)) });
            nextUsage.milliseconds = Math.max(nextUsage.milliseconds, performance.now() - started);
            if (exceedsBudget(nextUsage, options.budget)) { stoppedBy = "budget"; return finish(); }
            usage = nextUsage;
            if (visited.contains(link.id)) continue;
            visited.add(link.id);
            const target = index.get(link.id);
            if (target.isEmpty()) continue;
            const object = target.get();
            validateObject(object);
            if (!inScope(object, options.scope, options.now) || object.stale || isExpired(object, options.now)) continue;
            candidates.push({ object: structuredClone(object), via: current.object.id, depth: current.depth + 1, reason: link.reason, authorization: "not_granted" });
            queue.put(tail++, { object, depth: current.depth + 1 });
        }
    }
    return finish();
}
