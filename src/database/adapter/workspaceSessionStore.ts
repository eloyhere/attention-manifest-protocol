/**
 * SQLite adapters for the workspace session ports.
 *
 * `SessionStore` and `SessionContextStore` both declare a one-argument
 * `load(sessionId)` with incompatible return types (`SessionDescriptor` versus
 * `SessionContextEntry[]`). A single class could satisfy that only with a
 * type-level overload that returns the wrong value for one of the two ports at
 * runtime, so the ports are implemented by two adapters over the same
 * `WorkspaceSessionRepository`:
 *
 * ```ts
 * const store = new SqliteWorkspaceSessionStore(db);
 * const contextStore = new SqliteWorkspaceSessionContextStore(db);
 * const registry = new SessionRegistry({ store, contextStore });
 * ```
 *
 * The two adapters are cheap; they share the database connection and each
 * constructs a repository, which is a thin statement holder rather than a
 * connection pool. The class names are distinct from `SqliteSessionStore` in
 * `sessionStore.ts`, which implements the unrelated runtime-session port.
 */
import type { DatabaseSync } from "node:sqlite";

import type { AgentId, SessionContextEntry, SessionContextStore, SessionDescriptor, SessionId, SessionStore } from "../../session/types.ts";
import { WorkspaceSessionRepository } from "../repository/workspaceSessionRepository.ts";

/**
 * `SessionStore` adapter over `workspace_sessions` and `session_roots`.
 */
export class SqliteWorkspaceSessionStore implements SessionStore {
    private readonly repository: WorkspaceSessionRepository;

    /**
     * Create the adapter.
     *
     * @param db - Open SQLite connection with the schema applied.
     */
    constructor(db: DatabaseSync) {
        this.repository = new WorkspaceSessionRepository(db);
    }

    /**
     * Load one descriptor and its roots.
     *
     * @param sessionId - Session handle.
     * @returns Descriptor, or `undefined` when unknown.
     */
    load(sessionId: SessionId): SessionDescriptor | undefined {
        return this.repository.load(sessionId);
    }

    /**
     * Load the persisted bearer digest.
     *
     * @param sessionId - Session handle.
     * @returns `sha256:<hex>` token hash, or `undefined` when unknown.
     */
    loadSecret(sessionId: SessionId): string | undefined {
        return this.repository.loadSecret(sessionId);
    }

    /**
     * Insert or replace a descriptor together with its roots.
     *
     * @param descriptor - Public session record.
     * @param tokenHash - Bearer digest; never the token itself.
     */
    save(descriptor: SessionDescriptor, tokenHash: string): void {
        this.repository.save(descriptor, tokenHash);
    }

    /**
     * Delete a session with its roots and context.
     *
     * @param sessionId - Session handle.
     * @returns `true` when the session existed.
     */
    delete(sessionId: SessionId): boolean {
        return this.repository.delete(sessionId);
    }

    /**
     * List sessions, optionally by agent.
     *
     * @param agentId - Optional host-assigned agent identity.
     * @returns Descriptors ordered by creation time.
     */
    list(agentId?: AgentId): SessionDescriptor[] {
        return this.repository.list(agentId);
    }
}

/**
 * `SessionContextStore` adapter over `session_context`.
 */
export class SqliteWorkspaceSessionContextStore implements SessionContextStore {
    private readonly repository: WorkspaceSessionRepository;

    /**
     * Create the adapter.
     *
     * @param db - Open SQLite connection with the schema applied.
     */
    constructor(db: DatabaseSync) {
        this.repository = new WorkspaceSessionRepository(db);
    }

    /**
     * Load every context entry of one session.
     *
     * @param sessionId - Session handle.
     * @returns Entries ordered by namespace and key.
     */
    load(sessionId: SessionId): SessionContextEntry[] {
        return this.repository.loadContext(sessionId);
    }

    /**
     * Insert or replace one entry.
     *
     * @param sessionId - Session handle.
     * @param entry - Context entry.
     */
    put(sessionId: SessionId, entry: SessionContextEntry): void {
        this.repository.putContext(sessionId, entry);
    }

    /**
     * Delete one entry.
     *
     * @param sessionId - Session handle.
     * @param namespace - Context namespace.
     * @param key - Namespace-local key.
     * @returns `true` when an entry was removed.
     */
    delete(sessionId: SessionId, namespace: string, key: string): boolean {
        return this.repository.deleteContext(sessionId, namespace, key);
    }

    /**
     * Delete the whole context of one session.
     *
     * @param sessionId - Session handle.
     */
    deleteSession(sessionId: SessionId): void {
        this.repository.deleteContextSession(sessionId);
    }

    /**
     * Atomically replace the whole context of one session.
     *
     * @param sessionId - Session handle.
     * @param entries - Complete new entry set.
     */
    replace(sessionId: SessionId, entries: readonly SessionContextEntry[]): void {
        this.repository.replaceContext(sessionId, entries);
    }
}
