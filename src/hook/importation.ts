/**
 * Import hooks.
 *
 * `useParse` reports the outgoing imports of one file; `useImportation` wraps
 * the same session call as an observable hook and forwards `direction`,
 * `depth`, `includeExternal` and `limit` unchanged.
 *
 * Incoming edges are expensive because they require the root graph. The parse
 * helper therefore keeps the service default (`outgoing`); a caller that wants
 * `importedBy` asks for `direction: "incoming"` or `"both"` explicitly.
 */
import type { ImportRequest } from "../file/service.ts";
import type { ImportReport } from "../file/types.ts";
import type { Hook, HookOptions, HookSession } from "./types.ts";
import { createHook } from "./types.ts";

/**
 * Parse helper shape: one path in, one import report out.
 */
export type ImportationParse = (path: string) => ImportReport;

/**
 * Read the outgoing import report for one path.
 *
 * @param session - Bound filesystem session.
 * @returns Parse helper.
 */
export const useParse: (session: HookSession) => ImportationParse = (session: HookSession): ImportationParse => (path: string): ImportReport =>
    session.imports({ path });

/**
 * Importation hook.
 *
 * @param session - Bound filesystem session.
 * @param options - Recorder and cache options.
 * @returns Hook producing one import report.
 */
export const useImportation: (session: HookSession, options?: HookOptions) => Hook<ImportRequest, ImportReport> = (session: HookSession, options: HookOptions = {}): Hook<ImportRequest, ImportReport> =>
    createHook<ImportRequest, ImportReport>({
        name: "importation",
        session,
        execute: (request: ImportRequest): ImportReport => session.imports(request),
        pathOf: (request: ImportRequest): string => request.path,
        options,
    });
