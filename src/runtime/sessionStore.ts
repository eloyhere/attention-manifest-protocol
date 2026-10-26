/**
 * Session persistence port. The runtime owns `SessionSnapshot`; adapters may
 * store it in SQLite, a file, or memory.
 */
import type { SessionSnapshot } from "./session.ts";

export interface SessionStore {
    load(pid: number): SessionSnapshot | undefined;
    save(pid: number, snapshot: SessionSnapshot, at: string): void;
    /**
     * Retain the snapshot but mark it archived.
     */
    archive(pid: number, at: string): boolean;
    /**
     * Delete the snapshot when the agent is removed/archived.
     */
    delete(pid: number): boolean;
}

export class MemorySessionStore implements SessionStore {
    private readonly snapshots = new Map<number, SessionSnapshot>();

    load(pid: number): SessionSnapshot | undefined {
        return this.snapshots.get(pid);
    }

    save(pid: number, snapshot: SessionSnapshot, _at: string): void {
        this.snapshots.set(pid, snapshot);
    }

    archive(pid: number, at: string): boolean {
        const snapshot = this.snapshots.get(pid);
        if (snapshot === (void 0)) {
            return false;
        }
        this.snapshots.set(pid, { ...snapshot, archivedAt: at });
        return true;
    }

    delete(pid: number): boolean {
        return this.snapshots.delete(pid);
    }
}
