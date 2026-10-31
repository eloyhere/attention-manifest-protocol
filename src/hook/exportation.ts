/**
 * Export hooks.
 *
 * `useParse` is the cheap read helper; `useExportation` is the observable hook.
 * Both call `FilesystemSession.exports`, so re-export edges, signatures and the
 * fingerprint come from the one extractor the service already uses.
 */
import type { ExportRequest } from "../file/service.ts";
import type { ExportReport } from "../file/types.ts";
import type { Hook, HookOptions, HookSession } from "./types.ts";
import { createHook } from "./types.ts";

/**
 * Parse helper shape: one path in, one export report out.
 */
export type ExportationParse = (path: string) => ExportReport;

/**
 * Read the export report for one path. Re-exports are included because a
 * module's public surface is incomplete without them.
 *
 * @param session - Bound filesystem session.
 * @returns Parse helper.
 */
export const useParse: (session: HookSession) => ExportationParse = (session: HookSession): ExportationParse => (path: string): ExportReport =>
    session.exports({ path, includeReexports: true });

/**
 * Exportation hook. `includeReexports` is forwarded unchanged, so a caller can
 * ask for the narrow symbol list or the complete surface.
 *
 * @param session - Bound filesystem session.
 * @param options - Recorder and cache options.
 * @returns Hook producing one export report.
 */
export const useExportation: (session: HookSession, options?: HookOptions) => Hook<ExportRequest, ExportReport> = (session: HookSession, options: HookOptions = {}): Hook<ExportRequest, ExportReport> =>
    createHook<ExportRequest, ExportReport>({
        name: "exportation",
        session,
        execute: (request: ExportRequest): ExportReport => session.exports(request),
        pathOf: (request: ExportRequest): string => request.path,
        options,
    });
