import type { SessionStore } from "../../runtime/sessionStore.ts";
import type { SessionSnapshot } from "../../runtime/session.ts";
import type { RuntimeSessionRepository } from "../repository/runtimeSessionRepository.ts";

export class SqliteSessionStore implements SessionStore {
    private readonly repository: RuntimeSessionRepository;

    constructor(repository: RuntimeSessionRepository) {
        this.repository = repository;
    }

    load(pid: number): SessionSnapshot | undefined {
        return this.repository.load(pid);
    }

    save(pid: number, snapshot: SessionSnapshot, at: string): void {
        this.repository.save(pid, snapshot, at);
    }

    archive(pid: number, at: string): boolean {
        const snapshot = this.repository.load(pid);
        if (snapshot === undefined) return false;
        this.repository.save(pid, { ...snapshot, archivedAt: at }, at);
        return true;
    }

    delete(pid: number): boolean {
        return this.repository.delete(pid) > 0;
    }
}
