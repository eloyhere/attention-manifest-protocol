/**
 * Code model hook.
 *
 * A code model is the smallest set of facts an agent needs before editing a
 * file: what language and content it is, what structure it has, what it imports
 * and what it exports. The model is assembled from the three service methods
 * (`outline`, `imports`, `exports`) and never from a second parser; the outline
 * already carries the fingerprint and the language tag, so the three parts
 * cannot disagree about which file version they describe.
 *
 * The model is deliberately not cached across paths: a caller asks for one
 * path, and the hook layer's optional cache keyed by the request handles
 * repetition.
 */
import type { ExportReport, ImportReport } from "../file/types.ts";
import type { OutlineResult } from "../outline/types.ts";
import type { Hook, HookOptions, HookSession } from "./types.ts";
import { createHook } from "./types.ts";

/**
 * Complete model for one source file.
 */
export interface CodeModel {
    readonly path: string;
    readonly language: string;
    readonly fingerprint: string;
    readonly outline: OutlineResult;
    readonly imports: ImportReport;
    readonly exports: ExportReport;
}

/**
 * Request accepted by `useCode`.
 */
export interface CodeRequest {
    readonly path: string;
    readonly maxNodes?: number;
    readonly maxDepth?: number;
}

/**
 * Parse helper shape: one path in, one code model out.
 */
export type CodeParse = (path: string) => CodeModel;

/**
 * Input accepted by the internal assembler. `CodeRequest` is structurally the
 * same shape, so the hook can pass its request straight through.
 */
interface CodeParseInput {
    readonly path: string;
    readonly maxNodes?: number;
    readonly maxDepth?: number;
}

/**
 * Build a code model from the service methods. This is the single assembly
 * point used by both the parse helper and the hook.
 *
 * @param session - Bound filesystem session.
 * @param request - Path and optional outline bounds.
 * @returns The assembled model.
 */
const codeModelOf: (session: HookSession, request: CodeParseInput) => CodeModel = (session: HookSession, request: CodeParseInput): CodeModel => {
    const outline: OutlineResult = session.outline({
        path: request.path,
        ...(request.maxNodes === (void 0) ? {} : { maxNodes: request.maxNodes }),
        ...(request.maxDepth === (void 0) ? {} : { maxDepth: request.maxDepth }),
    });
    const imports: ImportReport = session.imports({ path: request.path });
    const exports: ExportReport = session.exports({ path: request.path });
    return {
        path: request.path,
        language: outline.language,
        fingerprint: outline.fingerprint,
        outline,
        imports,
        exports,
    };
};

/**
 * Read the complete code model for one path.
 *
 * @param session - Bound filesystem session.
 * @returns Parse helper.
 */
export const useParse: (session: HookSession) => CodeParse =
    (session: HookSession): CodeParse =>
    (path: string): CodeModel =>
        codeModelOf(session, { path });

/**
 * Code model hook.
 *
 * @param session - Bound filesystem session.
 * @param options - Recorder and cache options.
 * @returns Hook producing one code model.
 */
export const useCode: (session: HookSession, options?: HookOptions) => Hook<CodeRequest, CodeModel> = (session: HookSession, options: HookOptions = {}): Hook<CodeRequest, CodeModel> =>
    createHook<CodeRequest, CodeModel>({
        name: "code",
        session,
        execute: (request: CodeRequest): CodeModel => codeModelOf(session, request),
        pathOf: (request: CodeRequest): string => request.path,
        options,
    });
