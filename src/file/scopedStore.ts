import type { FilesystemStore } from "./types.ts";
import type { SessionDescriptor } from "../session/types.ts";

/** Public root handles are local to a session. Persist only collision-free keys. */
export const scopeFilesystemStore = (store: FilesystemStore, session: SessionDescriptor): FilesystemStore => {
    const key = (rootId: string): string => JSON.stringify([session.workspaceId ?? "default", session.id, rootId]);
    return {
        loadTree: rootId => store.loadTree(key(rootId)),
        saveTree: (rootId, snapshot) => store.saveTree(key(rootId), snapshot),
        loadAnnotations: rootId => store.loadAnnotations(key(rootId)),
        saveAnnotation: (rootId, path, annotation, source) => store.saveAnnotation(key(rootId), path, annotation, source),
        appendWrite: entry => store.appendWrite({ ...entry, rootId: key(entry.rootId) }),
        listWrites: (sessionId, limit) => store.listWrites(sessionId, limit).map(entry => {
            const root = session.roots.find(candidate => key(candidate.id) === entry.rootId);
            return { ...entry, rootId: root?.id ?? entry.rootId };
        }),
        loadOutline: (rootId, path, fingerprint) => store.loadOutline(key(rootId), path, fingerprint),
        saveOutline: (rootId, outline) => store.saveOutline(key(rootId), outline),
        ...(store.removeOutline === (void 0) ? {} : { removeOutline: (rootId: string, path: string): void => store.removeOutline!(key(rootId), path) }),
        loadImports: (rootId, path, fingerprint) => store.loadImports(key(rootId), path, fingerprint),
        saveImports: (rootId, report) => store.saveImports(key(rootId), report),
        loadExports: (rootId, path, fingerprint) => store.loadExports(key(rootId), path, fingerprint),
        saveExports: (rootId, report) => store.saveExports(key(rootId), report),
        loadDependencyRevision: rootId => store.loadDependencyRevision(key(rootId)),
        saveDependencyRevision: (rootId, revision) => store.saveDependencyRevision(key(rootId), revision),
    };
};
