/** Office parser registration shared by strategies and the container adapter. */
import type { OutlineNode } from "./types.ts";

/**
 * Input the office parser receives. Office has no text lines of its own, so a
 * parser numbers sections in document order and uses `bytes` for byte coverage.
 */
export interface OfficeOutlineInput {
    readonly path: string;
    readonly bytes: Uint8Array;
}

/**
 * Office section extractor. `office.ts` supplies the real implementation; until
 * it is registered the skeleton returns an empty section list so an Office file
 * still yields a valid file anchor instead of failing the whole tool.
 */
export type OfficeOutlineParser = (input: OfficeOutlineInput) => OutlineNode[];

/**
 * Mutable registration slot for the office extractor. A host calls
 * `registerOfficeOutlineParser` once at startup; the slot keeps the mutation
 * explicit instead of a module-level reassignable binding.
 */
const OfficeParserSlot: { parser: OfficeOutlineParser | undefined; } = { parser: undefined };

/**
 * Register (or clear) the Office section extractor.
 *
 * @param parser - Extractor to use, or `undefined` to restore the empty
 * skeleton.
 */
export const registerOfficeOutlineParser: (parser: OfficeOutlineParser | undefined) => void = (parser: OfficeOutlineParser | undefined): void => {
    OfficeParserSlot.parser = parser;
};

/** Whether an Office section extractor is currently registered. */
export const hasOfficeOutlineParser: () => boolean = (): boolean => OfficeParserSlot.parser !== (void 0);

/**
 * Extract Office sections through the registered parser.
 *
 * @param input - Path and raw container bytes.
 * @returns Section nodes in document order; empty when no parser is registered.
 */
export const parseOffice: (input: OfficeOutlineInput) => OutlineNode[] = (input: OfficeOutlineInput): OutlineNode[] => {
    const parser: OfficeOutlineParser | undefined = OfficeParserSlot.parser;
    return parser === (void 0) ? [] : parser(input);
};

