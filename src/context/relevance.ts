/**
 * Relevance model for `ContextBuilder`: draft items, deterministic scoring and
 * the prefix index that turns "close to an anchor" into a number.
 *
 * A draft is mutable because provenance promotion and evidence merging happen
 * while a package is assembled; the frozen `ContextItem` is the public
 * artifact. Scoring depends only on the draft, the weights and the anchor
 * prefixes, so two builders with the same inputs compute identical scores.
 */
import { estimateTokens } from "./agentContext.ts";
import { ContextBuilderError } from "./contextPackage.ts";
import type { ContextItem, ContextItemKind, ContextProvenance, ContextRange } from "./contextPackage.ts";
import { renderContextItem } from "./contextPackage.ts";
import { Trie } from "../structure/trie.ts";

/**
 * Multipliers for the five scoring signals.
 *
 * A larger weight means the signal matters more; the defaults keep explicit
 * anchors first, then structural proximity, then graph proximity.
 */
export interface ContextWeights {
    readonly anchor: number;
    readonly prefix: number;
    readonly outlineDepth: number;
    readonly graphDistance: number;
    readonly note: number;
}

/**
 * Default weights: an anchor dominates, a note is a strong host signal, a
 * deeper symbol is worth slightly less than the anchor that contains it.
 */
export const DefaultContextWeights: ContextWeights = Object.freeze({
    anchor: 1,
    prefix: 0.6,
    outlineDepth: 0.3,
    graphDistance: 0.4,
    note: 0.5,
});

/**
 * The only accepted weight names; an unknown key is a caller bug, not a
 * silently ignored override.
 */
const WeightKeys: readonly (keyof ContextWeights)[] = ["anchor", "prefix", "outlineDepth", "graphDistance", "note"];

/**
 * Upper bound for one weight. It keeps a hostile override from making scores
 * depend on unrepresentable magnitudes.
 */
const MaxWeight: number = 1_000;

/**
 * One candidate item before budget admission.
 *
 * `why` is mutable because a later view of the same module merges its evidence
 * into the surviving item; `graphDistance` may shrink for the same reason.
 */
export interface ContextItemDraft {
    readonly id: string;
    readonly kind: ContextItemKind;
    readonly path: string;
    readonly summary: string;
    readonly detailRef?: string;
    readonly range?: ContextRange;
    readonly provenance: ContextProvenance;
    why: string;
    graphDistance?: number;
    outlineDepth?: number;
    parentId?: string;
}

/**
 * A draft with its computed ranking value.
 */
export interface ScoredDraft {
    readonly draft: ContextItemDraft;
    readonly score: number;
}

/**
 * Order in which provenance outranks other provenance for the same identity.
 *
 * A file the host asked for outranks the same file discovered through a
 * directory listing, an outline, the import graph and the dependency graph, in
 * that order. Promotion keeps the strongest representation without letting the
 * call order change the result.
 *
 * @param provenance - Provenance to rank.
 * @returns A larger number for stronger provenance.
 */
export const provenanceRank: (provenance: ContextProvenance) => number = (provenance: ContextProvenance): number => {
    switch (provenance) {
        case "anchor": {
            return 5;
        }
        case "tree": {
            return 4;
        }
        case "outline": {
            return 3;
        }
        case "import": {
            return 2;
        }
        case "export": {
            return 1;
        }
        default: {
            return 0;
        }
    }
};

/**
 * Resolve a partial weight override against the defaults.
 *
 * @param input - Optional overrides; omitted names keep their default.
 * @returns Frozen, fully populated weights.
 * @throws ContextBuilderError when a name is unknown or a value is not a finite
 * non-negative number no greater than 1000.
 */
export const resolveContextWeights: (input?: Partial<ContextWeights>) => ContextWeights = (input: Partial<ContextWeights> = {}): ContextWeights => {
    const merged: ContextWeights = { ...DefaultContextWeights };
    const resolved: Record<string, number> = {
        anchor: merged.anchor,
        prefix: merged.prefix,
        outlineDepth: merged.outlineDepth,
        graphDistance: merged.graphDistance,
        note: merged.note,
    };
    Object.keys(input).forEach((key: string): void => {
        if (!WeightKeys.includes(key as keyof ContextWeights)) {
            throw new ContextBuilderError("invalid_arguments");
        }
        const value: unknown = (input as Record<string, unknown>)[key];
        if (typeof(value) !== "number" || !Number.isFinite(value) || value < 0 || value > MaxWeight) {
            throw new ContextBuilderError("invalid_arguments");
        }
        resolved[key] = value;
    });
    return Object.freeze({
        anchor: resolved.anchor,
        prefix: resolved.prefix,
        outlineDepth: resolved.outlineDepth,
        graphDistance: resolved.graphDistance,
        note: resolved.note,
    });
};

/**
 * Prefix index over anchor paths, backed by a character trie.
 *
 * `add` deduplicates an already indexed prefix (and is idempotent), while
 * `longest` answers "which anchor prefix does this path live under?" in
 * O(path length) instead of scanning every anchor. The ratio it returns feeds
 * the prefix signal: a path that shares more of its length with an anchor
 * prefix scores higher.
 */
export class PathPrefixIndex {
    private readonly trie: Trie<boolean> = new Trie<boolean>();

    /**
     * Register one anchor path or directory prefix.
     *
     * @param prefix - Non-empty path or directory prefix (with trailing `/`).
     */
    add(prefix: string): void {
        if (prefix.length === 0 || this.trie.has(prefix)) {
            return;
        }
        this.trie.insert(prefix, true);
    }

    /**
     * Longest registered prefix of `path`.
     *
     * @param path - Workspace-relative path.
     * @returns The longest matching prefix, or `""` when none matches.
     */
    longest(path: string): string {
        if (path.length === 0) {
            return "";
        }
        const match: ReturnType<Trie<boolean>["longestPrefix"]> = this.trie.longestPrefix(path);
        return match === (void 0) ? "" : match.key;
    }

    /**
     * Covered fraction of a path.
     *
     * @param path - Workspace-relative path.
     * @returns `prefix.length / path.length` in `[0, 1]`; 0 for an empty path.
     */
    ratio(path: string): number {
        if (path.length === 0) {
            return 0;
        }
        return this.longest(path).length / path.length;
    }

    /**
     * Number of registered prefixes.
     *
     * @returns Terminal count of the trie.
     */
    size(): number {
        return this.trie.size;
    }
}

/**
 * Round a score to six decimals so JSON output and equality checks are stable
 * across engines that accumulate floating point differently.
 *
 * @param value - Raw score.
 * @returns The rounded score.
 */
const roundScore: (value: number) => number = (value: number): number => Math.round(value * 1_000_000) / 1_000_000;

/**
 * Function shape of {@link scoreDraft}, so the implementation signature stays
 * on one line.
 */
type DraftScorer = (draft: ContextItemDraft, weights: ContextWeights, prefixes: PathPrefixIndex) => number;

/**
 * Score one draft.
 *
 * Signals are additive: explicit anchor provenance, the fraction of the path
 * covered by an anchor prefix, outline depth (shallower is better), graph
 * distance (closer is better), and host notes. Graph distance is ignored for an
 * explicit anchor, because an anchored file must score identically whether it
 * was anchored first or promoted from an earlier discovery; that is what makes
 * call order irrelevant. The result is rounded so equal inputs produce
 * bit-identical output.
 *
 * @param draft - Candidate item.
 * @param weights - Resolved weights.
 * @param prefixes - Anchor prefix index.
 * @returns The rounded, non-negative score.
 */
export const scoreDraft: DraftScorer = (draft: ContextItemDraft, weights: ContextWeights, prefixes: PathPrefixIndex): number => {
    const anchor: number = draft.provenance === "anchor" ? weights.anchor : 0;
    const prefix: number = weights.prefix * prefixes.ratio(draft.path);
    const outlineDepth: number = draft.outlineDepth === (void 0) ? 0 : weights.outlineDepth / (1 + draft.outlineDepth);
    const graphDistance: number = draft.graphDistance === (void 0) || draft.provenance === "anchor" ? 0 : weights.graphDistance / (1 + draft.graphDistance);
    const note: number = draft.kind === "note" ? weights.note : 0;
    return roundScore(anchor + prefix + outlineDepth + graphDistance + note);
};

/**
 * Build the public shape of a draft for rendering or admission charging.
 *
 * @param draft - Candidate item.
 * @param score - Ranking value to expose.
 * @returns An item with zero `tokens` until the builder charges it.
 */
export const draftContextItem: (draft: ContextItemDraft, score: number) => ContextItem = (draft: ContextItemDraft, score: number): ContextItem => {
    return {
        id: draft.id,
        kind: draft.kind,
        path: draft.path,
        summary: draft.summary,
        ...(draft.detailRef === (void 0) ? {} : { detailRef: draft.detailRef }),
        ...(draft.range === (void 0) ? {} : { range: { startLine: draft.range.startLine, endLine: draft.range.endLine } }),
        tokens: 0,
        score,
        provenance: draft.provenance,
        why: draft.why,
    };
};

/**
 * Pluggable token measurement. The default is `estimateTokens`; a host with a
 * real tokenizer supplies its own so CJK text is not budgeted at four
 * characters per token.
 */
export type TokenEstimator = (text: string) => number;

/**
 * Function shape of {@link draftTokens}, keeping its signature on one line.
 */
type DraftTokenizer = (draft: ContextItemDraft, estimator?: TokenEstimator) => number;

/**
 * Token charge for one draft's prompt line.
 *
 * The charge covers the rendered line, not just the summary, because the
 * decoration is part of the prompt the model pays for. A budget rejection
 * therefore never hides a shortened summary: the whole line either fits or the
 * item is omitted.
 *
 * @param draft - Candidate item.
 * @param estimator - Token estimator; defaults to `estimateTokens`.
 * @returns The estimated tokens of the rendered line.
 */
export const draftTokens: DraftTokenizer = (draft: ContextItemDraft, estimator: TokenEstimator = estimateTokens): number => {
    return estimator(renderContextItem(draftContextItem(draft, 0)));
};

/**
 * Priority comparator for a max-first `PriorityQueue`.
 *
 * A larger result means "serve first". The order is: higher score, then
 * lexicographically smaller path, then smaller id. Because the queue breaks
 * remaining ties by arrival, the comparator plus the deterministic arrival
 * order makes selection independent of engine sort behavior.
 *
 * @param left - Left candidate.
 * @param right - Right candidate.
 * @returns Positive when `left` outranks `right`.
 */
export const compareScoredDrafts: (left: ScoredDraft, right: ScoredDraft) => number = (left: ScoredDraft, right: ScoredDraft): number => {
    if (left.score !== right.score) {
        return left.score - right.score;
    }
    if (left.draft.path !== right.draft.path) {
        return left.draft.path < right.draft.path ? 1 : -1;
    }
    if (left.draft.id === right.draft.id) {
        return 0;
    }
    return left.draft.id < right.draft.id ? 1 : -1;
};
