import { digestOf } from "../semantic/canonical.ts";
import type { Concept, ConceptExample, ConceptRelation } from "./concept.ts";
import type { ConceptBudget, ConceptCheckpoint, ConceptDrop, ConceptPrunePlan } from "./conceptBudgetTypes.ts";

/**
 * Concept economy: bound one concept's content, and bound how many versions of
 * it are kept in storage.
 *
 * The rules answer one question: what may be removed without making the concept
 * worse at being a concept? Duplicated examples, duplicated relations, relation
 * targets that no longer resolve, and examples beyond the reading budget. Never
 * the definition, the intension, the counterexamples, or the last example that
 * keeps the concept grounded.
 */

export const DefaultConceptBudget: ConceptBudget = {
    amp: "0.1",
    kind: "concept-budget",
    maxExamples: 8,
    minExamples: 1,
    maxRelations: 12,
    keepVersions: 1,
};

function normaliseText(text: string): string {
    return text.trim().toLowerCase().replace(/\s+/g, " ");
}

function utf8Bytes(value: unknown): number {
    return new TextEncoder().encode(JSON.stringify(value)).length;
}

function typicalityOf(example: ConceptExample): number {
    return typeof(example.typicality) === "number" ? example.typicality : 0.5;
}

function clip(text: string, limit = 60): string {
    const flat = text.trim().replace(/\s+/g, " ");
    return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
}

export interface ConceptPruneOptions {
    /**
     * Resolvers for relation targets. Without one, dangling relations cannot be detected.
     */
    known?: (kind: string, id: string) => boolean;
}

export interface ConceptPruneResult {
    concept: Concept;
    plan: ConceptPrunePlan;
}

function resolveBudget(overrides: Partial<ConceptBudget>): ConceptBudget {
    const budget: ConceptBudget = { ...DefaultConceptBudget, ...overrides, amp: "0.1", kind: "concept-budget" };
    for (const key of ["minExamples", "maxExamples", "maxRelations", "keepVersions"] as const) {
        if (!Number.isFinite(budget[key]) || Math.abs(budget[key]) > Number.MAX_SAFE_INTEGER) {
            throw new RangeError(`concept budget ${key} must be finite and safely representable`);
        }
    }
    const minExamples = Math.max(0, Math.floor(budget.minExamples));
    return {
        ...budget,
        minExamples,
        maxExamples: Math.max(minExamples, Math.floor(budget.maxExamples)),
        maxRelations: Math.max(0, Math.floor(budget.maxRelations)),
        keepVersions: Math.max(1, Math.floor(budget.keepVersions)),
    };
}

/**
 * A bounded view of one concept.
 *
 * Deterministic: the input is not mutated, and the same input yields the same
 * plan. `version` is carried over unchanged — a view is not a revision, and
 * bumping the version here would forge lineage.
 */
export function pruneConcept(concept: Concept, overrides: Partial<ConceptBudget> = {}, options: ConceptPruneOptions = {}): ConceptPruneResult {
    const budget = resolveBudget(overrides);
    const dropped: ConceptDrop[] = [];
    let reclaimed = 0;

    const drop = (item: ConceptDrop, raw: unknown): void => {
        dropped.push(item);
        reclaimed += utf8Bytes(raw);
    };

    const view: Concept = { ...concept };

    // Examples: collapse duplicates, then trim past the ceiling, never past the floor.
    if (concept.examples) {
        const unique = new Map<string, { example: ConceptExample; index: number }>();
        concept.examples.forEach((example, index) => {
            const key = normaliseText(example.description);
            const existing = unique.get(key);
            if (!existing) {
                unique.set(key, { example, index });
                return;
            }
            if (typicalityOf(example) > typicalityOf(existing.example)) {
                // The newcomer is the better example of the pair; the earlier one goes.
                drop(
                    {
                        slot: "example",
                        index: existing.index,
                        summary: clip(existing.example.description),
                        reason: "duplicate",
                        revisit_if: "if the kept example is removed as atypical",
                    },
                    existing.example,
                );
                unique.set(key, { example, index });
                return;
            }
            drop(
                {
                    slot: "example",
                    index,
                    summary: clip(example.description),
                    reason: "duplicate",
                    revisit_if: "if this example is rewritten with a detail the kept one lacks",
                },
                example,
            );
        });

        const kept = [...unique.values()].sort((a, b) => a.index - b.index);
        if (kept.length > budget.maxExamples) {
            const ranked = [...kept].sort((a, b) => typicalityOf(b.example) - typicalityOf(a.example) || a.index - b.index);
            const keep = new Set(ranked.slice(0, budget.maxExamples).map((item) => item.index));
            for (const item of ranked) {
                if (keep.has(item.index)) {
                    continue;
                }
                drop(
                    {
                        slot: "example",
                        index: item.index,
                        summary: clip(item.example.description),
                        reason: "over-budget",
                        revisit_if: "if the concept needs a broader extension again",
                    },
                    item.example,
                );
            }
            view.examples = kept.filter((item) => keep.has(item.index)).map((item) => item.example);
        } else {
            view.examples = kept.map((item) => item.example);
        }
    }

    // Counterexamples are the falsifiers; they are never trimmed (W-2).

    // Relations: duplicate, dangling, then over budget.
    if (concept.relations) {
        const seen = new Set<string>();
        const surviving: { relation: ConceptRelation; index: number }[] = [];
        concept.relations.forEach((relation, index) => {
            const key = `${relation.type}|${relation.target.kind}|${relation.target.id}`;
            if (seen.has(key)) {
                drop(
                    {
                        slot: "relation",
                        index,
                        summary: `${relation.type} → ${relation.target.kind}:${relation.target.id}`,
                        reason: "duplicate",
                        revisit_if: "if the duplicate gains a distinct provenance or weight",
                    },
                    relation,
                );
                return;
            }
            seen.add(key);
            if (options.known && options.known(relation.target.kind, relation.target.id) === false) {
                drop(
                    {
                        slot: "relation",
                        index,
                        summary: `${relation.type} → ${relation.target.kind}:${relation.target.id}`,
                        reason: "dangling",
                        revisit_if: `if ${relation.target.kind}:${relation.target.id} is imported again`,
                    },
                    relation,
                );
                return;
            }
            surviving.push({ relation, index });
        });

        const keep = surviving.slice(0, budget.maxRelations);
        for (const item of surviving.slice(budget.maxRelations)) {
            drop(
                {
                    slot: "relation",
                    index: item.index,
                    summary: `${item.relation.type} → ${item.relation.target.kind}:${item.relation.target.id}`,
                    reason: "over-budget",
                    revisit_if: "if the relation becomes load-bearing for a query",
                },
                item.relation,
            );
        }
        view.relations = keep.map((item) => item.relation);
    }

    // Extension: exact duplicates only. Membership refs may be external, so no dangling check.
    if (concept.extension) {
        const seen = new Set<string>();
        const kept = concept.extension.filter((ref, index) => {
            const key = `${ref.kind}:${ref.id}`;
            if (!seen.has(key)) {
                seen.add(key);
                return true;
            }
            drop({ slot: "extension", index, summary: key, reason: "duplicate", revisit_if: "if the duplicate comes from a different source" }, ref);
            return false;
        });
        view.extension = kept;
    }

    return {
        concept: view,
        plan: {
            amp: "0.1",
            kind: "concept-prune-plan",
            concept: concept.id,
            version: concept.version,
            dropped,
            reclaimedBytes: reclaimed,
            budget,
        },
    };
}

export class ConceptCompactionRefused extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ConceptCompactionRefused";
    }
}

export interface ConceptHistoryCompaction {
    checkpoint: ConceptCheckpoint;
    head: Concept;
    removed: Concept[];
}

/**
 * Replace every version except the retained tail with a checkpoint.
 *
 * Refuses on a gap in the version sequence: a checkpoint over a broken lineage
 * would assert that nothing is missing while being unable to prove it.
 */
export function compactConceptHistory(versions: Concept[], options: { keepVersions?: number; now?: string } = {}): ConceptHistoryCompaction {
    if (versions.length === 0) {
        throw new ConceptCompactionRefused("no versions to compact");
    }

    const ordered = [...versions].sort((a, b) => a.version - b.version);
    const id = ordered[0].id;
    for (const version of ordered) {
        if (version.id !== id) {
            throw new ConceptCompactionRefused(`versions belong to different concepts: ${id} and ${version.id}`);
        }
    }
    for (let index = 1; index < ordered.length; index++) {
        if (ordered[index].version !== ordered[index - 1].version + 1) {
            throw new ConceptCompactionRefused(`lineage is broken between version ${ordered[index - 1].version} and ${ordered[index].version}`);
        }
    }

    const requested = options.keepVersions ?? 1;
    if (!Number.isFinite(requested) || Math.abs(requested) > Number.MAX_SAFE_INTEGER) {
        throw new ConceptCompactionRefused("keepVersions must be finite and safely representable");
    }
    const keepVersions = Math.max(1, Math.floor(requested));
    const cut = ordered.length - keepVersions;
    if (cut <= 0) {
        throw new ConceptCompactionRefused("nothing to compact: every version is inside the retention window");
    }

    const removed = ordered.slice(0, cut);
    const head = ordered[ordered.length - 1];
    const last = removed[removed.length - 1];

    return {
        checkpoint: {
            amp: "0.1",
            kind: "concept-checkpoint",
            id: `cp.concept.${id}.${last.version}`,
            concept: id,
            from: removed[0].version,
            to: last.version,
            count: removed.length,
            tip: digestOf(last),
            root: digestOf(removed),
            created: options.now ?? new Date().toISOString(),
            budget: { keepVersions },
        },
        head,
        removed,
    };
}

/**
 * Check a concept checkpoint against the versions it claims to cover.
 */
export function verifyConceptCheckpoint(checkpoint: ConceptCheckpoint, removed: Concept[], head?: Concept): { ok: boolean; reasons: string[] } {
    const reasons: string[] = [];

    if (digestOf(removed) !== checkpoint.root) {
        reasons.push("checkpoint root does not cover the removed versions");
    }
    if (removed.length !== checkpoint.count) {
        reasons.push(`checkpoint count ${checkpoint.count} does not match ${removed.length} removed versions`);
    }

    for (let index = 1; index < removed.length; index++) {
        if (removed[index].version !== removed[index - 1].version + 1) {
            reasons.push(`removed versions are not contiguous at ${removed[index - 1].version} → ${removed[index].version}`);
        }
    }

    const first = removed[0];
    const last = removed[removed.length - 1];
    if (!first || !last) {
        reasons.push("no versions were removed");
    } else {
        if (first.version !== checkpoint.from) {
            reasons.push(`checkpoint starts at ${checkpoint.from} but the first removed version is ${first.version}`);
        }
        if (last.version !== checkpoint.to) {
            reasons.push(`checkpoint ends at ${checkpoint.to} but the last removed version is ${last.version}`);
        }
        if (digestOf(last) !== checkpoint.tip) {
            reasons.push("checkpoint tip does not match the last removed version");
        }
        for (const version of removed) {
            if (version.id !== checkpoint.concept) {
                reasons.push(`removed version ${version.version} belongs to ${version.id}`);
            }
        }
    }

    if (head) {
        if (head.id !== checkpoint.concept) {
            reasons.push(`head belongs to ${head.id}, not ${checkpoint.concept}`);
        }
        if (head.version !== checkpoint.to + 1) {
            reasons.push(`head version ${head.version} does not continue from ${checkpoint.to}`);
        }
    }

    return { ok: reasons.length === 0, reasons };
}
