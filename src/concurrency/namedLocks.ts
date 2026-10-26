/**
 * Named mutexes for one worker.
 *
 * A single process may need to serialize access to a resource (a file, a
 * browser tab, an MCP session) without blocking unrelated work. The registry
 * keeps one {@link Mutex} per name; `UnorderedMap` is enough because names are
 * opaque and the lock itself carries no ordering.
 *
 * This is intra-worker only. Cross-worker exclusion is the database lease
 * (`claimThread`), not a promise.
 */
import { UnorderedMap } from "../structure/unordered.ts";
import { Mutex } from "./mutex.ts";

export class NamedLocks {
    private readonly locks: UnorderedMap<string, Mutex> = new UnorderedMap<string, Mutex>();

    forName(name: string): Mutex {
        const existing = this.locks.get(name);
        if (existing !== undefined) return existing;
        const mutex: Mutex = new Mutex();
        this.locks.set(name, mutex);
        return mutex;
    }

    run<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
        return this.forName(name).run(fn);
    }

    get size(): number {
        return this.locks.size;
    }
}
