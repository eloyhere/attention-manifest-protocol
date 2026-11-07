import assert from "node:assert/strict";
import test from "node:test";
import type { CacheStats, EntityCache } from "../cache/types.ts";
import type { EntityDescriptor } from "../entity/types.ts";
import type { SqlDriver } from "../sql/types.ts";
import { migrate, openSqlite } from "../sql/index.ts";
import { appendEvent, createSqliteRepository, readEvents } from "./index.ts";
import type { RepositoryContext } from "./index.ts";

interface Widget {
    readonly id: string;
    readonly tenantId?: string;
    readonly sessionId?: string;
    readonly version: number;
    readonly updatedAt: string;
    readonly name: string;
    readonly nested: {
        readonly tags: readonly string[];
        readonly meta: { readonly score: number };
    };
}

interface WidgetPayload {
    readonly name: string;
    readonly nested: Widget["nested"];
}

const widgetDescriptor: EntityDescriptor<Widget> = {
    kind: "task",
    table: "entities",
    keyOf: (widget) => widget.id,
    versionOf: (widget) => widget.version,
    encode: (widget) => ({
        id: widget.id,
        ...(widget.tenantId === undefined ? {} : { tenantId: widget.tenantId }),
        ...(widget.sessionId === undefined ? {} : { sessionId: widget.sessionId }),
        version: widget.version,
        updatedAt: widget.updatedAt,
        payload: { name: widget.name, nested: widget.nested },
    }),
    decode: (record) => {
        const payload = record.payload as WidgetPayload;
        return {
            id: record.id,
            ...(record.tenantId === undefined ? {} : { tenantId: record.tenantId }),
            ...(record.sessionId === undefined ? {} : { sessionId: record.sessionId }),
            version: record.version,
            updatedAt: record.updatedAt,
            name: payload.name,
            nested: payload.nested,
        };
    },
};

const goalDescriptor: EntityDescriptor<Widget> = { ...widgetDescriptor, kind: "goal" };

class FakeCache implements EntityCache {
    private readonly entries = new Map<string, unknown>();
    public hits = 0;
    public misses = 0;
    public sets = 0;
    public deletes = 0;
    public invalidations = 0;
    public evictions = 0;
    public expirations = 0;

    public get<T>(key: string, now: string): T | undefined {
        void now;
        if (this.entries.has(key)) {
            this.hits += 1;
            return this.entries.get(key) as T;
        }
        this.misses += 1;
        return undefined;
    }

    public set<T>(key: string, value: T, now: string): void {
        void now;
        this.sets += 1;
        this.entries.set(key, value);
    }

    public has(key: string): boolean {
        return this.entries.has(key);
    }

    public delete(key: string): boolean {
        this.deletes += 1;
        return this.entries.delete(key);
    }

    public invalidate(predicate: (key: string) => boolean): number {
        this.invalidations += 1;
        let removed = 0;
        for (const key of [...this.entries.keys()]) {
            if (predicate(key)) {
                this.entries.delete(key);
                removed += 1;
            }
        }
        return removed;
    }

    public clear(): void {
        this.entries.clear();
    }

    public stats(): CacheStats {
        const accesses = this.hits + this.misses;
        return {
            entries: this.entries.size,
            hits: this.hits,
            misses: this.misses,
            evictions: this.evictions,
            expirations: this.expirations,
            hitRate: accesses === 0 ? 0 : this.hits / accesses,
        };
    }
}

function contextFor(driver: SqlDriver, cache: EntityCache = new FakeCache(), tenantId?: string): RepositoryContext {
    return {
        driver,
        cache,
        now: () => "2026-01-01T00:00:00.000Z",
        ...(tenantId === undefined ? {} : { tenantId }),
    };
}

function widget(id: string, version: number, updatedAt: string, overrides: Partial<Widget> = {}): Widget {
    return {
        id,
        version,
        updatedAt,
        name: `widget-${id}`,
        nested: { tags: ["alpha", "beta"], meta: { score: 3 } },
        ...overrides,
    };
}

test("repository CRUD round-trips JSON and serves reads through the cache", () => {
    const driver = openSqlite({ path: ":memory:" });
    try {
        migrate(driver);
        const cache = new FakeCache();
        const repository = createSqliteRepository(widgetDescriptor, contextFor(driver, cache));
        const first = widget("w1", 0, "2026-01-01T00:00:00.000Z", {
            tenantId: "tenant-a",
            nested: { tags: ["one", "two"], meta: { score: 7 } },
        });
        assert.deepEqual(repository.put(first), first);
        assert.equal(cache.sets, 1);
        assert.deepEqual(repository.get("w1"), first);
        assert.equal(cache.hits, 1);
        cache.clear();
        assert.deepEqual(repository.get("w1"), first);
        assert.equal(cache.misses >= 1, true);
        assert.equal(cache.sets, 2);
        assert.deepEqual(repository.get("w1"), first);
        assert.equal(cache.hits, 2);
        const second = { ...first, version: 1, updatedAt: "2026-01-02T00:00:00.000Z", name: "renamed" };
        assert.deepEqual(repository.put(second, { expectedVersion: 0 }), second);
        assert.deepEqual(repository.get("w1"), second);
        assert.equal(repository.count(), 1);
        assert.equal(repository.delete("w1"), true);
        assert.equal(repository.delete("w1"), false);
        assert.equal(repository.get("w1"), undefined);
        assert.equal(repository.count(), 0);
    } finally {
        driver.close();
    }
});

test("expectedVersion enforces compare-and-swap", () => {
    const driver = openSqlite({ path: ":memory:" });
    try {
        migrate(driver);
        const repository = createSqliteRepository(widgetDescriptor, contextFor(driver));
        const stable = widget("w1", 2, "2026-01-01T00:00:00.000Z");
        repository.put(stable);
        assert.throws(
            () => repository.put({ ...stable, version: 3, name: "stale" }, { expectedVersion: 1 }),
            (error: unknown) => error instanceof Error && error.message === "version_conflict",
        );
        assert.deepEqual(repository.get("w1"), stable);
        const next = { ...stable, version: 3, name: "next" };
        repository.put(next, { expectedVersion: 2 });
        assert.deepEqual(repository.get("w1"), next);
        const fresh = widget("w2", 0, "2026-01-02T00:00:00.000Z");
        repository.put(fresh, { expectedVersion: 0 });
        assert.deepEqual(repository.get("w2"), fresh);
        assert.throws(
            () => repository.put(widget("missing", 3, "2026-01-03T00:00:00.000Z"), { expectedVersion: 2 }),
            (error: unknown) => error instanceof Error && error.message === "version_conflict",
        );
        assert.equal(repository.get("missing"), undefined);
        assert.throws(() => repository.put(fresh, { expectedVersion: -1 }), /expectedVersion/);
    } finally {
        driver.close();
    }
});

test("list and count filter, order and limit", () => {
    const driver = openSqlite({ path: ":memory:" });
    try {
        migrate(driver);
        const repository = createSqliteRepository(widgetDescriptor, contextFor(driver, new FakeCache(), "tenant-a"));
        repository.put(widget("a", 0, "2026-01-01T00:00:00.000Z", { tenantId: "tenant-a", sessionId: "s1" }));
        repository.put(widget("b", 0, "2026-01-03T00:00:00.000Z", { tenantId: "tenant-a", sessionId: "s1" }));
        repository.put(widget("c", 0, "2026-01-02T00:00:00.000Z", { tenantId: "tenant-a", sessionId: "s2" }));
        repository.put(widget("d", 0, "2026-01-04T00:00:00.000Z", { tenantId: "tenant-b" }));
        assert.deepEqual(repository.list().map((item) => item.id), ["b", "c", "a"]);
        assert.deepEqual(repository.list({ sessionId: "s1" }).map((item) => item.id), ["b", "a"]);
        assert.deepEqual(repository.list({ tenantId: "tenant-b" }).map((item) => item.id), ["d"]);
        assert.deepEqual(repository.list({ limit: 2 }).map((item) => item.id), ["b", "c"]);
        assert.deepEqual(repository.list({ limit: 0 }), []);
        assert.equal(repository.list({ kind: "task" }).length, 3);
        assert.equal(repository.count(), 3);
        assert.equal(repository.count({ sessionId: "s1" }), 2);
        assert.equal(repository.count({ limit: 1 }), 3);
        repository.put(widget("tie-a", 0, "2026-01-05T00:00:00.000Z", { tenantId: "tenant-a" }));
        repository.put(widget("tie-b", 0, "2026-01-05T00:00:00.000Z", { tenantId: "tenant-a" }));
        assert.deepEqual(repository.list({ limit: 2 }).map((item) => item.id), ["tie-a", "tie-b"]);
        const goals = createSqliteRepository(goalDescriptor, contextFor(driver, new FakeCache(), "tenant-a"));
        goals.put(widget("g1", 0, "2026-01-06T00:00:00.000Z", { tenantId: "tenant-a" }));
        assert.deepEqual(goals.list().map((item) => item.id), ["g1"]);
        assert.equal(repository.list().some((item) => item.id === "g1"), false);
    } finally {
        driver.close();
    }
});

test("events append in sequence, filter by kind and round-trip payloads", () => {
    const driver = openSqlite({ path: ":memory:" });
    try {
        migrate(driver);
        assert.deepEqual(readEvents(driver), []);
        const first = appendEvent(driver, {
            kind: "task",
            entityId: "t1",
            recordedAt: "2026-01-01T00:00:00.000Z",
            payload: { nested: { values: [1, 2, 3] } },
        });
        const second = appendEvent(driver, {
            kind: "goal",
            recordedAt: "2026-01-01T00:00:01.000Z",
            payload: ["x", { y: true }],
        });
        const third = appendEvent(driver, {
            kind: "task",
            entityId: "t2",
            recordedAt: "2026-01-01T00:00:02.000Z",
            payload: "plain text",
        });
        assert.deepEqual([first.sequence, second.sequence, third.sequence], [1, 2, 3]);
        const all = readEvents(driver);
        assert.deepEqual(all.map((event) => event.sequence), [1, 2, 3]);
        assert.deepEqual(all[0]?.payload, { nested: { values: [1, 2, 3] } });
        assert.deepEqual(all[1]?.payload, ["x", { y: true }]);
        assert.equal(all[2]?.payload, "plain text");
        assert.equal(Object.hasOwn(all[1], "entityId"), false);
        assert.deepEqual(readEvents(driver, { kind: "task" }).map((event) => event.sequence), [1, 3]);
        assert.deepEqual(readEvents(driver, { kind: "goal" }).map((event) => event.sequence), [2]);
        assert.deepEqual(readEvents(driver, { limit: 2 }).map((event) => event.sequence), [1, 2]);
        assert.deepEqual(readEvents(driver, { kind: "goal", limit: 1 }).map((event) => event.sequence), [2]);
        assert.deepEqual(readEvents(driver, { limit: 0 }), []);
        assert.throws(() => driver.transaction(() => {
            appendEvent(driver, { kind: "task", entityId: "rolled-back", recordedAt: "2026-01-01T00:00:03.000Z", payload: null });
            throw new Error("rollback event");
        }), /rollback event/);
        assert.equal(readEvents(driver).length, 3);
    } finally {
        driver.close();
    }
});
