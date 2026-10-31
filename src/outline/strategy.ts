/** Contracts for pure, replayable outline strategies. */
import type { LineIndex } from "../syntax/charset.ts";
import type { OutlineCategory, OutlineNode } from "./types.ts";

/**
 * Input a strategy matcher sees. `head` is the first few KiB of decoded text so
 * a content-sniffing matcher never needs the whole file.
 */
export interface OutlineMatchInput {
    readonly path: string;
    readonly name: string;
    readonly head: string;
}

/**
 * Input a strategy parser sees. `text` may be a 3000-line prefix of the file
 * when the file is larger; `lineIndex` indexes exactly that text. Line numbers
 * are therefore still 1-based and still point at the original file as long as
 * the caller did not scan past the prefix.
 */
export interface OutlineParseInput {
    readonly path: string;
    readonly text: string;
    readonly lineIndex: LineIndex;
    /**
     * Report that the parser hit its own bounded scan limit and the returned
     * symbols are incomplete. The registry folds this into `truncated`, so a
     * strategy-level cap (for example the HTML tag budget) stays visible even
     * when the node and depth budgets were not reached.
     */
    readonly markTruncated?: () => void;
}

/**
 * One outline parser. `id` is the stable strategy tag written to
 * `OutlineResult.strategy`; `category` is the coarse family used for
 * rendering. `language` is optional because a plain-text file answers with its
 * extension instead of a language name.
 *
 * A parser returns symbols only; the registry assigns the anchor path and the
 * byte range from the symbol's line numbers.
 */
export interface OutlineStrategy {
    readonly id: string;
    readonly category: OutlineCategory;
    readonly language?: string;
    readonly matches: (input: OutlineMatchInput) => boolean;
    readonly parse: (input: OutlineParseInput) => OutlineNode[];
}

