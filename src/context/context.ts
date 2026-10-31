/**
 * Context assembly: choose which resident pages enter the model's prompt.
 *
 * Pinned pages always go in; the rest are taken most-recently-used first until
 * the prompt budget is exhausted. Anything skipped is returned as `excluded`
 * with its token cost, so an omission is visible instead of silent.
 */
import type { Page } from "../window/page.ts";
import type { ContextWindow } from "../window/window.ts";

export interface ContextSegment {
    kind: string;
    id: string;
    tokens: number;
    pinned: boolean;
    content?: unknown;
}

export interface ContextAssembly {
    segments: ContextSegment[];
    tokens: number;
    budgetTokens: number;
    excluded: ContextSegment[];
}

const toSegment = (page: Page): ContextSegment => {
    const segment: ContextSegment = {
        kind: page.objectKind,
        id: page.objectId,
        tokens: page.tokens,
        pinned: page.pinned > 0,
    };
    if (page.content !== (void 0)) {
        segment.content = page.content;
    }
    return segment;
};

export const assembleContext = (window: ContextWindow, budgetTokens: number): ContextAssembly => {
    if (!Number.isSafeInteger(budgetTokens) || budgetTokens < 0) {
        throw new RangeError("budgetTokens must be a non-negative safe integer");
    }
    const pages: Page[] = window.entries().slice();
    pages.sort((left, right) => {
        const pinDiff: number = (right.pinned > 0 ? 1 : 0) - (left.pinned > 0 ? 1 : 0);
        if (pinDiff !== 0) {
            return pinDiff;
        }
        return right.lastUsed - left.lastUsed;
    });

    const segments: ContextSegment[] = [];
    const excluded: ContextSegment[] = [];
    let used: number = 0;
    for (const page of pages) {
        const segment: ContextSegment = toSegment(page);
        if (used + page.tokens <= budgetTokens) {
            segments.push(segment);
            used += page.tokens;
        } else {
            excluded.push(segment);
        }
    }
    return { segments, tokens: used, budgetTokens, excluded };
};
