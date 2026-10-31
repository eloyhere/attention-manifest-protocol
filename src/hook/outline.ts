/**
 * Outline hooks.
 *
 * The parse helper accepts the full filesystem `OutlineOptions`, but only the
 * options the service request can express are forwarded: `maxNodes`,
 * `maxDepth` and `symbols`. `anchor` is an internal optimisation the service
 * owns and a caller cannot supply through the tool surface, so it is ignored
 * rather than forging a cached node.
 *
 * `useOutline` forwards the complete `OutlineRequest`, including `query`,
 * `startLine` and `endLine`, because those are caller-visible filters.
 */
import type { OutlineOptions } from "../outline/outline.ts";
import type { OutlineRequest } from "../file/service.ts";
import type { OutlineResult } from "../outline/types.ts";
import type { Hook, HookOptions, HookSession } from "./types.ts";
import { createHook } from "./types.ts";

/**
 * Parse helper shape. `options` bounds the outline; `anchor` is not forwarded.
 */
export type OutlineParse = (path: string, options?: OutlineOptions) => OutlineResult;

/**
 * Read the outline of one file or directory.
 *
 * @param session - Bound filesystem session.
 * @returns Parse helper.
 */
export const useParse: (session: HookSession) => OutlineParse =
    (session: HookSession): OutlineParse =>
    (path: string, options: OutlineOptions = {}): OutlineResult =>
        session.outline({
            path,
            ...(options.maxNodes === (void 0) ? {} : { maxNodes: options.maxNodes }),
            ...(options.maxDepth === (void 0) ? {} : { maxDepth: options.maxDepth }),
            ...(options.symbols === (void 0) ? {} : { symbols: options.symbols }),
        });

/**
 * Outline hook.
 *
 * @param session - Bound filesystem session.
 * @param options - Recorder and cache options.
 * @returns Hook producing one outline result.
 */
export const useOutline: (session: HookSession, options?: HookOptions) => Hook<OutlineRequest, OutlineResult> = (session: HookSession, options: HookOptions = {}): Hook<OutlineRequest, OutlineResult> =>
    createHook<OutlineRequest, OutlineResult>({
        name: "outline",
        session,
        execute: (request: OutlineRequest): OutlineResult => session.outline(request),
        pathOf: (request: OutlineRequest): string => request.path,
        options,
    });
