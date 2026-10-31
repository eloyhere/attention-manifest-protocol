/**
 * Dependency hooks.
 *
 * Two layers are exposed. `useParse` is a plain read helper that returns the
 * import and export reports for one path; it exists so a caller that only needs
 * facts does not have to create a hook or subscribe to state. `useDependency`
 * wraps the graph query itself and keeps its bounded report observable.
 *
 * Both layers call the session methods directly. No graph algorithm is
 * re-implemented here: the service already owns the import graph cache, cycle
 * detection, topological order and closures, and duplicating any of that would
 * create two answers to "what depends on this?".
 */
import type { DependencyQuery } from "../file/service.ts";
import type { DependencyReport, ExportReport, ImportReport } from "../file/types.ts";
import type { Hook, HookOptions, HookSession } from "./types.ts";
import { createHook } from "./types.ts";

/**
 * Facts returned by the dependency parse helper.
 */
export interface DependencyFacts {
    readonly path: string;
    readonly imports: ImportReport;
    readonly exports: ExportReport;
}

/**
 * Parse helper shape: one path in, both reports out.
 */
export type DependencyParse = (path: string) => DependencyFacts;

/**
 * Read the import and export reports for one path. Both calls are read-only and
 * use the session's outgoing direction.
 *
 * @param session - Bound filesystem session.
 * @returns Parse helper.
 */
export const useParse: (session: HookSession) => DependencyParse = (session: HookSession): DependencyParse => (path: string): DependencyFacts => {
    const imports: ImportReport = session.imports({ path });
    const exports: ExportReport = session.exports({ path });
    return { path, imports, exports };
};

/**
 * Dependency graph hook. The request is passed through unchanged, including
 * `roots`, `direction`, `depth`, `limit` and `includeExternal`.
 *
 * @param session - Bound filesystem session.
 * @param options - Recorder and cache options.
 * @returns Hook producing a bounded dependency report.
 */
export const useDependency: (session: HookSession, options?: HookOptions) => Hook<DependencyQuery, DependencyReport> = (session: HookSession, options: HookOptions = {}): Hook<DependencyQuery, DependencyReport> =>
    createHook<DependencyQuery, DependencyReport>({
        name: "dependency",
        session,
        execute: (request: DependencyQuery): DependencyReport => session.dependency(request),
        pathOf: (request: DependencyQuery): string | undefined => request.roots?.[0],
        options,
    });
