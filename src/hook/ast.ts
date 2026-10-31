/**
 * Syntax-tree hooks.
 *
 * The parse helper exposes the lossless CST directly; `useAst` adds the standard
 * hook state, cache and audit record. Both are read-only: the parser never
 * evaluates or imports the target file.
 */
import type { AstRequest } from "../file/service.ts";
import type { SyntaxTree } from "../syntax/syntaxTree.ts";
import type { Hook, HookOptions, HookSession } from "./types.ts";
import { createHook } from "./types.ts";

/**
 * Parse helper shape.
 */
export type AstParse = (path: string, options?: Omit<AstRequest, "path">) => SyntaxTree;

/**
 * Parse one file into a syntax tree without hook state.
 *
 * @param session - Bound filesystem session.
 * @returns Parse helper.
 */
export const useParse: (session: HookSession) => AstParse =
    (session: HookSession): AstParse =>
    (path: string, options: Omit<AstRequest, "path"> = {}): SyntaxTree =>
        session.ast({ path, ...options });

/**
 * Syntax-tree hook.
 *
 * @param session - Bound filesystem session.
 * @param options - Recorder and cache options.
 * @returns Hook producing one syntax tree.
 */
export const useAst: (session: HookSession, options?: HookOptions) => Hook<AstRequest, SyntaxTree> = (
    session: HookSession,
    options: HookOptions = {},
): Hook<AstRequest, SyntaxTree> =>
    createHook<AstRequest, SyntaxTree>({
        name: "ast",
        session,
        execute: (request: AstRequest): SyntaxTree => session.ast(request),
        pathOf: (request: AstRequest): string => request.path,
        options,
    });
