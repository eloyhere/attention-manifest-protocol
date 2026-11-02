#!/usr/bin/env node
/** Independent, serial audit. KNOWN findings assert the observed defect, not a passing security guarantee. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Database } from "../src/database/service/database.ts";
import { openStore, putObject, verifyObjectChain } from "../src/database/store/database.ts";
import { registerCatalogWriteGuard } from "../src/database/store/catalogGuard.ts";
import { Schema } from "../src/database/sql/schema.ts";
import { SqliteWorkspaceSessionStore, SqliteWorkspaceSessionContextStore } from "../src/database/adapter/workspaceSessionStore.ts";
import { SqliteFilesystemStore } from "../src/database/adapter/filesystemStore.ts";
import { SessionRegistry } from "../src/session/registry.ts";
import { SessionRuntime } from "../src/file/runtime.ts";
import type { ControlPort } from "../src/control/types.ts";

const folder = mkdtempSync(join(tmpdir(), "amp-audit-control-"));
const rootA = join(folder, "root-a"), rootB = join(folder, "root-b");
mkdirSync(rootA); mkdirSync(rootB);
let passed = 0, failed = 0;
const findings: string[] = [];
const test = (name: string, run: () => void) => {
    try { run(); passed++; console.log(`PASS ${name}`); }
    catch (error) { failed++; console.error(`FAIL ${name}`, error); }
};
const known = (id: string, name: string, run: () => void) => test(`KNOWN ${id}: ${name}`, () => { run(); findings.push(id); });
const denies = (run: () => unknown, code: string) => assert.throws(run, (error: unknown) => error instanceof Error && error.message === code);
const changes = (db: DatabaseSync) => (db.prepare("SELECT total_changes() n").get() as { n: number }).n;
const call = (port: ControlPort, scope: "global" | "workspace" | "session", domain: "adjust" | "interaction" | "scenario", args: Record<string, unknown>) => port.call(scope, domain, args);
const fixture = (run: (database: Database, registry: SessionRegistry) => void) => {
    const database = new Database(":memory:");
    database.controlService.createWorkspace("a", "A"); database.controlService.createWorkspace("b", "B");
    const registry = new SessionRegistry({ store: new SqliteWorkspaceSessionStore(database.db), contextStore: new SqliteWorkspaceSessionContextStore(database.db) });
    try { run(database, registry); } finally { database.close(); }
};
const open = (registry: SessionRegistry, workspaceId = "a", id = "root", path = rootA) => registry.open({ agentId: workspaceId, workspaceId, roots: [{ id, path, writable: false, exclude: [] }] });

try {
    test("CP-01 fixed: nonempty persisted context forks after child row creation", () => fixture((database, registry) => {
        const parent = open(registry);
        registry.context.set(parent.descriptor.id, "ns", "k", { value: 1 }, new Date().toISOString());
        const child = registry.fork(parent.descriptor.id);
        assert.deepEqual(database.workspaceSessions.loadContext(child.descriptor.id).map(entry => entry.value), [{ value: 1 }]);
    }));
    test("CP-02 fixed: stale registry cannot revive a revoked session", () => fixture((database, first) => {
        const opened = open(first);
        const second = new SessionRegistry({ store: database.workspaceSessions });
        second.revoke(opened.descriptor.id);
        const bound = database.controlService.bind({ workspaceId: "a", sessionId: opened.descriptor.id, authenticate: () => { first.authenticate(opened.descriptor.id, opened.credential.token); } });
        denies(() => call(bound, "session", "interaction", { action: "set", mode: "think" }), "permission_denied");
        assert.equal(database.workspaceSessions.load(opened.descriptor.id)?.status, "revoked");
    }));
    test("CP-03 fixed: same public root ID in different workspaces isolates persisted annotations", () => fixture((database, registry) => {
        const a = open(registry, "a", "root", rootA), b = open(registry, "b", "root", rootB);
        assert.notEqual(a.descriptor.roots[0].path, b.descriptor.roots[0].path);
        const filesystem = new SqliteFilesystemStore(database.db);
        const runtimeA = new SessionRuntime(a.descriptor, { store: filesystem });
        const runtimeB = new SessionRuntime(b.descriptor, { store: filesystem });
        runtimeA.setAnnotation(a.descriptor.roots[0], "secret.ts", { summary: "workspace A private annotation" });
        assert.equal(runtimeB.annotationsFor(b.descriptor.roots[0])["secret.ts"], undefined);
        assert.equal(runtimeA.annotationsFor(a.descriptor.roots[0])["secret.ts"].summary, "workspace A private annotation");
    }));
    test("CP-04 fixed: verify callback leaves dryRun and rejected CAS read-only", () => fixture((database, registry) => {
        const opened = open(registry);
        const bound = database.controlService.bind({ workspaceId: "a", sessionId: opened.descriptor.id, authenticate: () => { registry.verify(opened.descriptor.id, opened.credential.token); } });
        const before = changes(database.db), revision = database.workspaceSessions.load(opened.descriptor.id)!.revision;
        call(bound, "session", "interaction", { action: "set", mode: "think", dryRun: true });
        assert.equal(changes(database.db), before);
        assert.equal(database.workspaceSessions.load(opened.descriptor.id)!.revision, revision);
        denies(() => call(bound, "session", "interaction", { action: "set", mode: "think", expectedVersion: 99 }), "version_conflict");
        assert.equal(changes(database.db), before);
        assert.equal(database.workspaceSessions.load(opened.descriptor.id)!.revision, revision);
    }));
    test("CP-05 fixed: authentication callback cannot reenter the control port", () => fixture((database) => {
        let innerCode: string | undefined;
        let bound: ControlPort;
        bound = database.controlService.bind({ workspaceId: "a", authenticate: () => {
            try { call(bound, "workspace", "interaction", { action: "set", mode: "think" }); }
            catch (error) { innerCode = (error as { code?: string }).code; }
        } });
        assert.equal(call(bound, "workspace", "interaction", { action: "get" }).version, 0);
        assert.equal(innerCode, "control_unavailable");
        assert.equal(database.controlService.bind({ workspaceId: "a" }).call("workspace", "interaction", { action: "get" }).version, 0);
    }));
    test("CP-06 fixed: session revision overflow fails closed without writing", () => fixture((database, registry) => {
        const opened = open(registry);
        database.db.prepare("UPDATE workspace_sessions SET revision=? WHERE session_id=?").run(Number.MAX_SAFE_INTEGER, opened.descriptor.id);
        const restored = new SessionRegistry({ store: database.workspaceSessions });
        const before = changes(database.db);
        denies(() => restored.authenticate(opened.descriptor.id, opened.credential.token), "store_failure");
        assert.equal(changes(database.db), before);
        assert.equal((database.workspaceSessions.load(opened.descriptor.id)!.revision), Number.MAX_SAFE_INTEGER);
    }));

    test("global partial authority denies reads/defaults/writes; workspace identity is immutable", () => fixture((database, registry) => {
        const opened = open(registry);
        const allowed = ["a"];
        const identity = { workspaceId: "a", sessionId: opened.descriptor.id, allowGlobal: true, authorizedWorkspaceIds: allowed };
        const limited = database.controlService.bind(identity);
        identity.workspaceId = "b"; allowed.push("b", "default");
        const requests = [
            ["interaction", { action: "get" }], ["scenario", { action: "set", scenario: "research", applyTo: "all" }],
            ["adjust", { action: "list", registry: "skills" }], ["adjust", { action: "default_get", registry: "skills", key: "k" }],
            ["adjust", { action: "register", registry: "skills", id: "x", value: {} }],
        ] as const;
        for (const [domain, args] of requests) denies(() => call(limited, "global", domain, args), "permission_denied");
        denies(() => call(limited, "global", "interaction", { action: "get", workspaceId: "b" }), "permission_denied");
        denies(() => call(limited, "workspace", "interaction", { action: "get", workspaceId: "b" }), "invalid_arguments");
        denies(() => call(limited, "session", "interaction", { action: "get", sessionId: opened.descriptor.id }), "invalid_arguments");
        assert.equal(call(limited, "workspace", "interaction", { action: "get" }).workspaceId, "a");
        assert.throws(() => database.db.prepare("UPDATE workspace_sessions SET workspace_id='b' WHERE session_id=?").run(opened.descriptor.id), /immutable/);
        const original = database.workspaceSessions.load(opened.descriptor.id)!;
        assert.throws(() => database.workspaceSessions.save({ ...original, workspaceId: "b" }, "hash"), /immutable/);
        assert.equal(database.workspaceSessions.load(opened.descriptor.id)?.workspaceId, "a");
    }));
    test("suspended/revoked/expired/closed and mismatched sessions cannot use control", () => fixture((database, registry) => {
        const opened = open(registry), id = opened.descriptor.id;
        const bound = database.controlService.bind({ workspaceId: "a", sessionId: id });
        registry.suspend(id); denies(() => bound.call("workspace", "interaction", { action: "get" }), "permission_denied");
        registry.resume(id); assert.equal(bound.call("session", "interaction", { action: "get" }).version, 0);
        denies(() => database.controlService.bind({ workspaceId: "b", sessionId: id }).call("workspace", "interaction", { action: "get" }), "permission_denied");
        database.db.prepare("UPDATE workspace_sessions SET idle_expires_at=? WHERE session_id=?").run(new Date(0).toISOString(), id);
        denies(() => bound.call("session", "interaction", { action: "get" }), "permission_denied");
        const revoked = open(registry, "a", "revoked");
        const revokedPort = database.controlService.bind({ workspaceId: "a", sessionId: revoked.descriptor.id });
        registry.revoke(revoked.descriptor.id);
        denies(() => revokedPort.call("session", "interaction", { action: "get" }), "permission_denied");
        registry.close(revoked.descriptor.id);
        denies(() => revokedPort.call("session", "interaction", { action: "get" }), "permission_denied");
    }));
    test("global/workspace/session inheritance and CAS reset retain local version", () => fixture((database, registry) => {
        const opened = open(registry);
        const global = database.controlService.bind({ workspaceId: "a", allowGlobal: true });
        const local = database.controlService.bind({ workspaceId: "a", sessionId: opened.descriptor.id });
        global.call("global", "interaction", { action: "set", mode: "think", expectedVersion: 0 });
        assert.equal(local.call("session", "interaction", { action: "get" }).source, "global");
        local.call("workspace", "interaction", { action: "set", mode: "converge", expectedVersion: 0 });
        local.call("session", "interaction", { action: "set", mode: "affect", expectedVersion: 0 });
        assert.equal(local.call("session", "interaction", { action: "get" }).source, "session");
        const reset = local.call("session", "interaction", { action: "reset", expectedVersion: 1 });
        assert.equal(reset.source, "workspace"); assert.equal(reset.version, 2);
        denies(() => local.call("session", "interaction", { action: "set", mode: "think", expectedVersion: 1 }), "version_conflict");
        local.call("workspace", "interaction", { action: "reset", expectedVersion: 1 });
        assert.equal(local.call("session", "interaction", { action: "get" }).source, "global");
    }));
    test("registry inherited links are copied, tombstones isolated, resurrection removes links, defaults reset", () => fixture((database) => {
        const global = database.controlService.bind({ workspaceId: "a", allowGlobal: true });
        const local = database.controlService.bind({ workspaceId: "a" });
        const adjust = (port: ControlPort, scope: "global" | "workspace", args: Record<string, unknown>) => port.call(scope, "adjust", { registry: "skills", ...args });
        adjust(global, "global", { action: "register", id: "x", value: { name: "shared" } });
        adjust(global, "global", { action: "link", id: "x", targetId: "external", relation: "depends", expectedVersion: 1 });
        assert.equal(adjust(local, "workspace", { action: "get", id: "x" }).version, 0);
        const preview = adjust(local, "workspace", { action: "unlink", id: "x", targetId: "external", relation: "depends", dryRun: true, expectedVersion: 0 });
        assert.deepEqual(preview.links, []);
        const updated = adjust(local, "workspace", { action: "update", id: "x", value: { name: "a" }, expectedVersion: 0 });
        assert.equal((updated.links as unknown[]).length, 1);
        adjust(local, "workspace", { action: "remove", id: "x", expectedVersion: 1 });
        assert.equal(database.controlService.listRegistry("a", "skills").length, 0);
        assert.equal(database.controlService.listRegistry("b", "skills").length, 1);
        denies(() => adjust(local, "workspace", { action: "get", id: "x" }), "not_available");
        const resurrect = adjust(local, "workspace", { action: "register", id: "x", value: {}, expectedVersion: 2 });
        assert.deepEqual(resurrect.links, []); assert.equal(resurrect.version, 3);
        adjust(global, "global", { action: "default_set", key: "k", value: "shared" });
        adjust(local, "workspace", { action: "default_set", key: "k", value: "local", expectedVersion: 0 });
        assert.equal(adjust(local, "workspace", { action: "default_reset", key: "k", expectedVersion: 1 }).value, "shared");
        assert.equal(adjust(local, "workspace", { action: "default_get", key: "k" }).version, 2);
    }));
    test("forbidden security keys/deep/non-JSON/accessors reject without writes or executing getters", () => fixture((database) => {
        const local = database.controlService.bind({ workspaceId: "a" });
        const before = changes(database.db);
        const forbidden = ["policy", "AUTH", "inputSchema", "executable", "risk", "authorization", "permissions", "execute", "handler", "script", "code", "__proto__", "constructor", "prototype"];
        const values: unknown[] = forbidden.map(key => ({ nested: JSON.parse(`{"${key}":{}}`) }));
        let deep: unknown = {}; for (let i = 0; i < 65; i++) deep = { nested: deep }; values.push(deep);
        const cycle: Record<string, unknown> = {}; cycle.self = cycle;
        let invoked = 0;
        values.push(cycle, { bad: NaN }, { bad: Infinity }, { bad: 1n }, { bad: undefined }, { bad: new Date() }, { bad: "\ud800" }, { bad: new Array(2) }, { get bad() { invoked++; return 1; } }, { bad: "x".repeat(1024 * 1024) });
        for (const value of values) denies(() => local.call("workspace", "adjust", { action: "register", registry: "skills", id: "unsafe", value }), "invalid_arguments");
        assert.equal(invoked, 0); assert.equal(changes(database.db), before);
    }));
    test("all/existing target current authorized workspace and active unexpired sessions only; dryRun total_changes stable", () => fixture((database, registry) => {
        const a = open(registry, "a", "a"), b = open(registry, "b", "b");
        const suspended = open(registry, "a", "s"), expired = open(registry, "a", "e"), revoked = open(registry, "a", "r");
        registry.suspend(suspended.descriptor.id); registry.revoke(revoked.descriptor.id);
        database.db.prepare("UPDATE workspace_sessions SET expires_at=? WHERE session_id=?").run(new Date(0).toISOString(), expired.descriptor.id);
        const limited = database.controlService.bind({ workspaceId: "a", allowGlobal: true, authorizedWorkspaceIds: ["a"] });
        const request = { action: "set", workspaceId: "a", mode: "think", applyTo: "all", expectedVersion: 0 };
        const before = changes(database.db);
        const preview = limited.call("global", "interaction", { ...request, dryRun: true });
        assert.deepEqual(preview.affectedSessions, [a.descriptor.id]); assert.equal(changes(database.db), before);
        limited.call("global", "interaction", request);
        assert.equal(database.controlService.bind({ workspaceId: "b", sessionId: b.descriptor.id }).call("session", "interaction", { action: "get" }).mix, null);
        assert.equal((database.db.prepare("SELECT count(*) n FROM control_preferences WHERE scope_key LIKE 'session:%'").get() as { n: number }).n, 1);
        const existing = limited.call("global", "scenario", { action: "set", workspaceId: "a", scenario: "research", applyTo: "existing" });
        assert.equal(existing.version, 0); assert.deepEqual(existing.affectedSessions, [a.descriptor.id]);
    }));
    test("batch failure/overflow rolls back default plus prior sessions; CAS and nested transaction reject", () => fixture((database, registry) => {
        const a = open(registry, "a", "a"), other = open(registry, "a", "other");
        const port = database.controlService.bind({ workspaceId: "a" });
        const before = database.db.prepare("SELECT * FROM control_preferences").all();
        database.db.exec("CREATE TRIGGER fail_session_preference BEFORE INSERT ON control_preferences WHEN NEW.scope_key LIKE 'session:%' BEGIN SELECT RAISE(ABORT, 'injected'); END");
        assert.throws(() => port.call("workspace", "interaction", { action: "set", mode: "think", applyTo: "all" }), /injected/);
        assert.deepEqual(database.db.prepare("SELECT * FROM control_preferences").all(), before);
        database.db.exec("DROP TRIGGER fail_session_preference");
        const bound = database.controlService.bind({ workspaceId: "a", sessionId: other.descriptor.id });
        bound.call("session", "interaction", { action: "set", mode: "think" });
        database.db.prepare("UPDATE control_preferences SET version=? WHERE scope_key=?").run(Number.MAX_SAFE_INTEGER, `session:${other.descriptor.id}`);
        denies(() => port.call("workspace", "interaction", { action: "set", mode: "converge", applyTo: "all" }), "version_conflict");
        assert.equal(port.call("workspace", "interaction", { action: "get" }).version, 0);
        assert.equal(database.controlService.bind({ workspaceId: "a", sessionId: a.descriptor.id }).call("session", "interaction", { action: "get" }).version, 0);
        database.db.exec("BEGIN");
        denies(() => port.call("workspace", "scenario", { action: "get" }), "control_unavailable"); database.db.exec("ROLLBACK");
        port.call("workspace", "adjust", { action: "register", registry: "skills", id: "x", value: {} });
        database.db.prepare("UPDATE registry_entries SET version=?").run(Number.MAX_SAFE_INTEGER);
        denies(() => port.call("workspace", "adjust", { action: "remove", registry: "skills", id: "x" }), "version_conflict");
        port.call("workspace", "adjust", { action: "default_set", registry: "skills", key: "x", value: 1 });
        database.db.prepare("UPDATE registry_defaults SET version=?").run(Number.MAX_SAFE_INTEGER);
        denies(() => port.call("workspace", "adjust", { action: "default_reset", registry: "skills", key: "x" }), "version_conflict");
    }));
    test("old single-PK roots migrate losslessly, empty fork IDs survive reopen, scheduler/hash chain unchanged", () => {
        const path = join(folder, "roots.sqlite");
        let database = new Database(path);
        const registry = new SessionRegistry({ store: database.workspaceSessions });
        const parent = open(registry, "default", "original-root");
        database.db.exec("DROP INDEX session_roots_session; ALTER TABLE session_roots RENAME TO session_roots_new; CREATE TABLE session_roots(root_id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES workspace_sessions(session_id) ON DELETE CASCADE,path TEXT NOT NULL,writable INTEGER NOT NULL,excludes_json TEXT NOT NULL,UNIQUE(session_id,path)); INSERT INTO session_roots SELECT * FROM session_roots_new; DROP TABLE session_roots_new");
        database.db.prepare("INSERT INTO processes(id,name,state,budget,used,created_at) VALUES('preserved','P','created','{}','{}',?)").run(new Date().toISOString());
        putObject(database.db, "evidence", "preserved", { value: 1 }, new Date().toISOString());
        const evidence = database.db.prepare("SELECT * FROM objects").all(); database.close();
        database = new Database(path);
        try {
            const restored = new SessionRegistry({ store: database.workspaceSessions });
            assert.equal(restored.get(parent.descriptor.id).roots[0].id, "original-root");
            const child = restored.fork(parent.descriptor.id);
            assert.deepEqual(child.descriptor.roots, parent.descriptor.roots);
            assert.deepEqual(database.db.prepare("SELECT * FROM objects").all(), evidence);
            assert.equal(verifyObjectChain(database.db).ok, true);
            assert.equal((database.db.prepare("SELECT count(*) n FROM processes").get() as { n: number }).n, 1);
            assert.deepEqual(database.db.prepare("PRAGMA foreign_key_check").all(), []);
            const second = new Database(path);
            try { assert.deepEqual(second.workspaceSessions.load(child.descriptor.id)?.roots, parent.descriptor.roots); } finally { second.close(); }
        } finally { database.close(); }
    });
    test("actual v4 missing workspace column migrates; failure rolls back column/version/scheduler/evidence", () => {
        for (const inject of [false, true]) {
            const path = join(folder, `v4-${inject}.sqlite`);
            const old = new DatabaseSync(path); registerCatalogWriteGuard(old);
            old.exec(Schema.slice(0, Schema.indexOf("/* A workspace is")) + `
                CREATE TABLE workspace_sessions(session_id TEXT PRIMARY KEY,agent_id TEXT NOT NULL,label TEXT NOT NULL,status TEXT NOT NULL,token_hash TEXT NOT NULL,permissions_json TEXT NOT NULL,created_at TEXT NOT NULL,expires_at TEXT NOT NULL,idle_expires_at TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 0,parent_id TEXT,metadata_json TEXT NOT NULL DEFAULT '{}');
                CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); INSERT INTO meta VALUES('schema_version','4');
                INSERT INTO workspace_sessions VALUES('old','a','old','active','hash','{}','2026','2099','2099',0,NULL,'{}');
                INSERT INTO processes(id,name,state,budget,used,created_at) VALUES('preserved','P','created','{}','{}','2026');`);
            putObject(old, "evidence", "preserved", { value: 1 }, new Date().toISOString());
            if (inject) old.exec("CREATE VIEW registry_entries AS SELECT 1 AS incompatible");
            const evidence = old.prepare("SELECT * FROM objects").all(); old.close();
            if (inject) {
                assert.throws(() => openStore(path));
                const check = new DatabaseSync(path);
                try {
                    assert.equal((check.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string }).value, "4");
                    assert.equal((check.prepare("PRAGMA table_info(workspace_sessions)").all() as { name: string }[]).some(c => c.name === "workspace_id"), false);
                    assert.deepEqual(check.prepare("SELECT * FROM objects").all(), evidence);
                    assert.equal((check.prepare("SELECT count(*) n FROM processes").get() as { n: number }).n, 1);
                } finally { check.close(); }
            } else {
                const migrated = openStore(path);
                try {
                    assert.equal((migrated.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys, 1);
                    assert.equal((migrated.prepare("SELECT workspace_id FROM workspace_sessions").get() as { workspace_id: string }).workspace_id, "default");
                    assert.deepEqual(migrated.prepare("SELECT * FROM objects").all(), evidence);
                    assert.equal(verifyObjectChain(migrated).ok, true);
                    assert.throws(() => migrated.exec("UPDATE workspace_sessions SET workspace_id='missing'"), /immutable/);
                } finally { migrated.close(); }
            }
        }
    });
} finally {
    // The only removal target is this test's freshly-created absolute temp directory.
    assert.equal(resolve(folder), folder); assert.ok(folder.includes("amp-audit-control-"));
    rmSync(folder, { recursive: true, force: true });
}
console.log(JSON.stringify({ passed, failed, observedKnownFindings: findings }));
if (failed) process.exitCode = 1;
