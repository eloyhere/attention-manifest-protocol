import type { DatabaseSync } from "node:sqlite";
import { assertJsonValue } from "../semantic/jsonValue.ts";
import { InteractionKinds, resolveInteraction, type InteractionMix } from "../interaction/interaction.ts";
import { ScenarioKinds, resolveScenario, type ScenarioMix } from "../scenario/scenario.ts";
import { ControlError, type ControlDomain, type ControlIdentity, type ControlPort, type ControlScope } from "./types.ts";

const wellFormed = (value: string): boolean => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value);
const registries = new Set(["modules", "skills", "knowledge", "protocols", "environments", "concepts"]);
const fail = (code: ConstructorParameters<typeof ControlError>[0]): never => { throw new ControlError(code); };
const text = (value: unknown): string => {
    if (typeof value !== "string" || !value.trim() || /[\u0000-\u001f\u007f-\u009f]/u.test(value) || !wellFormed(value)) return fail("invalid_arguments");
    return value;
};
const version = (value: unknown): number => {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return fail("invalid_arguments");
    return value;
};
const nextVersion = (value: number): number => {
    if (!Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER) return fail("version_conflict");
    return value + 1;
};
const checkVersion = (args: Record<string, unknown>, current: number): void => {
    if (args.expectedVersion !== undefined && version(args.expectedVersion) !== current) fail("version_conflict");
};
const keys = (args: Record<string, unknown>, allowed: readonly string[], required: readonly string[] = []): void => {
    if (Object.keys(args).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(args, key))) fail("invalid_arguments");
};
// JSON data must be inert even when called directly through the host API.
const data = (value: unknown, ancestors = new Set<object>(), depth = 0): unknown => {
    if (depth > 64) return fail("invalid_arguments");
    if (depth === 0) { try { assertJsonValue(value); } catch { return fail("invalid_arguments"); } }
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "string") { if (!wellFormed(value)) return fail("invalid_arguments"); return value; }
    if (typeof value === "number") { if (!Number.isFinite(value)) return fail("invalid_arguments"); return value; }
    if (typeof value !== "object" || ancestors.has(value)) return fail("invalid_arguments");
    const proto = Object.getPrototypeOf(value);
    if (!Array.isArray(value) && proto !== Object.prototype && proto !== null) return fail("invalid_arguments");
    ancestors.add(value);
    const output: Record<string, unknown> | unknown[] = Array.isArray(value) ? [] : Object.create(null) as Record<string, unknown>;
    for (const key of Reflect.ownKeys(value)) {
        if (key === "length" && Array.isArray(value)) continue;
        if (typeof key !== "string" || !wellFormed(key) || ["policy", "auth", "inputschema", "executable", "risk", "authorization", "permissions", "execute", "handler", "script", "code", "__proto__", "constructor", "prototype"].includes(key.toLowerCase())) return fail("invalid_arguments");
        const property = Object.getOwnPropertyDescriptor(value, key)!;
        if (!property.enumerable || !Object.hasOwn(property, "value")) return fail("invalid_arguments");
        (output as Record<string, unknown>)[key] = data(property.value, ancestors, depth + 1);
    }
    if (Array.isArray(output) && Object.keys(output).length !== output.length) return fail("invalid_arguments");
    ancestors.delete(value);
    return output;
};
const json = (value: unknown): string => {
    const result = JSON.stringify(data(value));
    if (Buffer.byteLength(result, "utf8") > 1024 * 1024) return fail("invalid_arguments");
    return result;
};

type Target = { scope: ControlScope; key: string; workspaceId?: string; sessionId?: string };
type Preference = { mix_json: string | null; version: number };
type Entry = { entry_id: string; value_json: string; status: string; version: number };
type Default = { value_json: string; version: number };
export interface WorkspaceRecord { workspaceId: string; name: string; status: string; isDefault: boolean; version: number; }

/** Durable control state. A bound port freezes host identity and never accepts caller identity. */
export class ScopedControlService {
    private readonly db: DatabaseSync;
    private authenticating = false;
    constructor(db: DatabaseSync) { this.db = db; }

    private atomic<T>(dryRun: boolean, operation: () => T): T {
        if (this.db.isTransaction) return fail("control_unavailable");
        this.db.exec("BEGIN IMMEDIATE");
        try {
            const result = operation();
            if (result !== null && typeof result === "object" && "then" in result) return fail("control_unavailable");
            this.db.exec(dryRun ? "ROLLBACK" : "COMMIT");
            return result;
        } catch (error) {
            try { this.db.exec("ROLLBACK"); } catch { /* Preserve the operation error. */ }
            throw error;
        }
    }

    createWorkspace(id: string, name: string): WorkspaceRecord {
        text(id); text(name);
        return this.atomic(false, () => {
            if (this.db.prepare("SELECT 1 FROM workspaces WHERE workspace_id=?").get(id)) return fail("version_conflict");
            const now = new Date().toISOString();
            this.db.prepare("INSERT INTO workspaces(workspace_id,name,status,is_default,version,created_at,updated_at) VALUES (?,?,'active',0,1,?,?)").run(id, name, now, now);
            return this.workspace(id);
        });
    }

    defaultWorkspace(): WorkspaceRecord {
        const row = this.db.prepare("SELECT workspace_id FROM workspaces WHERE is_default=1 AND status='active'").get() as { workspace_id: string } | undefined;
        return row ? this.workspace(row.workspace_id) : fail("not_available");
    }

    setDefaultWorkspace(id: string, expectedVersion?: number): WorkspaceRecord {
        text(id);
        if (expectedVersion !== undefined) version(expectedVersion);
        return this.atomic(false, () => {
            const current = this.defaultWorkspace();
            if (expectedVersion !== undefined && current.version !== expectedVersion) return fail("version_conflict");
            const target = this.workspace(id);
            if (target.status !== "active") return fail("not_available");
            const bumped = nextVersion(Math.max(current.version, target.version));
            this.db.prepare("UPDATE workspaces SET is_default=0,version=?,updated_at=? WHERE is_default=1").run(bumped, new Date().toISOString());
            this.db.prepare("UPDATE workspaces SET is_default=1,version=?,updated_at=? WHERE workspace_id=?").run(bumped, new Date().toISOString(), id);
            return this.workspace(id);
        });
    }

    private workspace(id: string): WorkspaceRecord {
        const row = this.db.prepare("SELECT workspace_id,name,status,is_default,version FROM workspaces WHERE workspace_id=?").get(id) as { workspace_id: string; name: string; status: string; is_default: number; version: number } | undefined;
        if (!row) return fail("not_available");
        return { workspaceId: row.workspace_id, name: row.name, status: row.status, isDefault: row.is_default === 1, version: row.version };
    }

    /** Effective registry snapshot for host adapters and search projection. */
    listRegistry(workspaceId: string, registry: string, includeRemoved = false): Record<string, unknown>[] {
        text(workspaceId);
        if (!registries.has(registry)) return fail("invalid_arguments");
        this.workspace(workspaceId);
        const entries = new Map<string, Record<string, unknown>>();
        for (const target of [{ scope: "global", key: "global" }, { scope: "workspace", key: `workspace:${workspaceId}`, workspaceId }] as Target[]) {
            const rows = this.db.prepare("SELECT entry_id,value_json,status,version FROM registry_entries WHERE scope_key=? AND registry=? ORDER BY entry_id").all(target.key, registry) as Entry[];
            for (const row of rows) {
                entries.set(row.entry_id, { ...this.entryView(target, registry, row), source: target.scope });
            }
        }
        return [...entries.values()].filter(entry => includeRemoved || entry.status !== "removed").sort((a, b) => String(a.id).localeCompare(String(b.id)));
    }

    bind(identity: ControlIdentity): ControlPort {
        const bound: ControlIdentity = Object.freeze({
            workspaceId: text(identity.workspaceId),
            ...(identity.sessionId === undefined ? {} : { sessionId: text(identity.sessionId) }),
            allowGlobal: identity.allowGlobal === true,
            ...(identity.authorizedWorkspaceIds === undefined ? {} : { authorizedWorkspaceIds: Object.freeze(identity.authorizedWorkspaceIds.map(text)) }),
            ...(identity.authenticate === undefined ? {} : { authenticate: identity.authenticate }),
        });
        if (bound.authenticate !== undefined && typeof bound.authenticate !== "function") return fail("invalid_arguments");
        return Object.freeze({ call: (scope: ControlScope, domain: ControlDomain, args: Record<string, unknown>): Record<string, unknown> => {
            if (!["global", "workspace", "session"].includes(scope) || !["adjust", "interaction", "scenario"].includes(domain)) return fail("invalid_arguments");
            if (args === null || typeof args !== "object" || Array.isArray(args) || (Object.getPrototypeOf(args) !== Object.prototype && Object.getPrototypeOf(args) !== null)) return fail("invalid_arguments");
            // Reject accessors before reading arguments; no caller code runs in a transaction.
            if (Reflect.ownKeys(args).some(key => typeof key !== "string" || !Object.hasOwn(Object.getOwnPropertyDescriptor(args, key)!, "value"))) return fail("invalid_arguments");
            const copied = { ...args };
            if (copied.dryRun !== undefined && typeof copied.dryRun !== "boolean") return fail("invalid_arguments");
            if (copied.expectedVersion !== undefined) version(copied.expectedVersion);
            if (this.db.isTransaction || this.authenticating) return fail("control_unavailable");
            if (bound.authenticate) {
                this.authenticating = true;
                try {
                    const result: unknown = bound.authenticate();
                    if (result !== undefined) {
                        if (result && typeof result === "object" && "then" in result) void Promise.resolve(result).catch(() => {});
                        return fail("permission_denied");
                    }
                } catch { return fail("permission_denied"); }
                finally { this.authenticating = false; }
            }
            return this.atomic(copied.dryRun === true, () => {
                this.authenticate(bound);
                const target = this.target(bound, scope, copied);
                const response = domain === "adjust" ? this.adjust(target, copied) : this.preference(bound, target, domain, copied);
                return { ...response, ...(copied.dryRun === true ? { dryRun: true } : {}) };
            });
        } });
    }

    private authenticate(identity: ControlIdentity): void {
        if (this.workspace(identity.workspaceId).status !== "active") return fail("permission_denied");
        if (identity.authorizedWorkspaceIds && !identity.authorizedWorkspaceIds.includes(identity.workspaceId)) return fail("permission_denied");
        if (identity.sessionId !== undefined) {
            const session = this.db.prepare("SELECT workspace_id,status,expires_at,idle_expires_at FROM workspace_sessions WHERE session_id=?").get(identity.sessionId) as { workspace_id: string; status: string; expires_at: string; idle_expires_at: string } | undefined;
            const now = Date.now();
            if (!session || session.workspace_id !== identity.workspaceId || session.status !== "active" || !(Date.parse(session.expires_at) > now) || !(Date.parse(session.idle_expires_at) > now)) return fail("permission_denied");
        }
    }

    private target(identity: ControlIdentity, scope: ControlScope, args: Record<string, unknown>): Target {
        if (Object.hasOwn(args, "sessionId") || (scope !== "global" && Object.hasOwn(args, "workspaceId"))) return fail("invalid_arguments");
        if (scope === "global") {
            if (identity.allowGlobal !== true) return fail("permission_denied");
            if (args.workspaceId !== undefined) {
                const id = text(args.workspaceId);
                if (identity.authorizedWorkspaceIds && !identity.authorizedWorkspaceIds.includes(id)) return fail("permission_denied");
                if (this.workspace(id).status !== "active") return fail("not_available");
                return { scope: "workspace", key: `workspace:${id}`, workspaceId: id };
            }
            if (identity.authorizedWorkspaceIds) {
                const workspaces = this.db.prepare("SELECT workspace_id FROM workspaces WHERE status='active'").all() as { workspace_id: string }[];
                if (workspaces.some(row => !identity.authorizedWorkspaceIds!.includes(row.workspace_id))) return fail("permission_denied");
            }
            return { scope, key: "global" };
        }
        if (scope === "session") {
            if (!identity.sessionId) return fail("not_available");
            return { scope, key: `session:${identity.sessionId}`, workspaceId: identity.workspaceId, sessionId: identity.sessionId };
        }
        return { scope, key: `workspace:${identity.workspaceId}`, workspaceId: identity.workspaceId };
    }

    private ensureScope(target: Target): void {
        this.db.prepare("INSERT OR IGNORE INTO control_scopes(scope_key,kind,workspace_id,session_id) VALUES (?,?,?,?)").run(target.key, target.scope, target.workspaceId ?? null, target.sessionId ?? null);
    }

    private readPreference(target: Target, domain: string): Preference | undefined {
        return this.db.prepare("SELECT mix_json,version FROM control_preferences WHERE scope_key=? AND domain=?").get(target.key, domain) as Preference | undefined;
    }

    private effective(target: Target, domain: string, override?: Preference): Record<string, unknown> {
        const local = override ?? this.readPreference(target, domain);
        let inherited = target;
        let selected = local;
        if (!selected?.mix_json && target.scope === "session") {
            inherited = { scope: "workspace", key: `workspace:${target.workspaceId!}`, workspaceId: target.workspaceId };
            selected = this.readPreference(inherited, domain);
        }
        if (!selected?.mix_json && target.scope !== "global") {
            inherited = { scope: "global", key: "global" };
            selected = this.readPreference(inherited, domain);
        }
        const mix: unknown = selected?.mix_json ? JSON.parse(selected.mix_json) : null;
        const plan = mix ? domain === "interaction" ? resolveInteraction(mix as InteractionMix) : resolveScenario(mix as ScenarioMix) : null;
        return { scope: target.scope, ...(target.workspaceId ? { workspaceId: target.workspaceId } : {}), ...(target.sessionId ? { sessionId: target.sessionId } : {}), mix, effectiveMix: mix, source: mix ? inherited.scope : null, version: local?.version ?? 0, effectiveVersion: mix ? selected!.version : 0, plan };
    }

    private writePreference(target: Target, domain: string, mix: string | null): number {
        const current = this.readPreference(target, domain)?.version ?? 0;
        const bumped = nextVersion(current);
        this.ensureScope(target);
        this.db.prepare("INSERT INTO control_preferences(scope_key,domain,mix_json,version,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(scope_key,domain) DO UPDATE SET mix_json=excluded.mix_json,version=excluded.version,updated_at=excluded.updated_at").run(target.key, domain, mix, bumped, new Date().toISOString());
        return bumped;
    }

    private preference(identity: ControlIdentity, target: Target, domain: "interaction" | "scenario", args: Record<string, unknown>): Record<string, unknown> {
        const action = text(args.action);
        if (!["get", "set", "reset"].includes(action)) return fail("invalid_arguments");
        const selector = domain === "interaction" ? "mode" : "scenario";
        keys(args, action === "get" ? ["action", "workspaceId"] : ["action", "workspaceId", "expectedVersion", "dryRun", "applyTo", ...(action === "set" ? [selector, "mix"] : [])]);
        if (action === "get") return this.effective(target, domain);
        const applyTo = args.applyTo ?? "defaults";
        if (!["defaults", "existing", "all"].includes(applyTo as string) || (target.scope === "session" && applyTo !== "defaults")) return fail("invalid_arguments");
        let mix: string | null = null;
        if (action === "set") {
            if ((args.mix === undefined) === (args[selector] === undefined)) return fail("invalid_arguments");
            const kinds: readonly string[] = domain === "interaction" ? InteractionKinds : ScenarioKinds;
            const value = args.mix ?? { [text(args[selector])]: 1 };
            const safe = data(value);
            if (!safe || typeof safe !== "object" || Array.isArray(safe) || Object.keys(safe).some(key => !kinds.includes(key))) return fail("invalid_arguments");
            const weights = Object.values(safe);
            const sum = weights.reduce<number>((total, weight) => total + (typeof weight === "number" ? weight : NaN), 0);
            if (weights.length === 0 || weights.some(weight => typeof weight !== "number" || !Number.isFinite(weight) || weight < 0) || !Number.isFinite(sum) || sum <= 0) return fail("invalid_arguments");
            try {
                const plan = domain === "interaction" ? resolveInteraction(safe as InteractionMix) : resolveScenario(safe as ScenarioMix);
                if (Object.values(plan.weights).some(weight => !Number.isFinite(weight))) return fail("invalid_arguments");
                mix = JSON.stringify(plan.weights);
            } catch { return fail("invalid_arguments"); }
        }
        checkVersion(args, this.readPreference(target, domain)?.version ?? 0);
        const affected: string[] = [];
        const dryRun = args.dryRun === true;
        const predicted = applyTo !== "existing" ? { mix_json: mix, version: nextVersion(this.readPreference(target, domain)?.version ?? 0) } : undefined;
        if (applyTo !== "existing" && !dryRun) this.writePreference(target, domain, mix);
        if (applyTo !== "defaults") {
            const rows = this.db.prepare("SELECT session_id,workspace_id FROM workspace_sessions WHERE status='active' AND expires_at>? AND idle_expires_at>? ORDER BY session_id").all(new Date().toISOString(), new Date().toISOString()) as { session_id: string; workspace_id: string }[];
            for (const row of rows) {
                if (target.scope === "workspace" && row.workspace_id !== target.workspaceId) continue;
                if (identity.authorizedWorkspaceIds && !identity.authorizedWorkspaceIds.includes(row.workspace_id)) continue;
                const sessionTarget: Target = { scope: "session", key: `session:${row.session_id}`, workspaceId: row.workspace_id, sessionId: row.session_id };
                nextVersion(this.readPreference(sessionTarget, domain)?.version ?? 0);
                if (!dryRun) this.writePreference(sessionTarget, domain, mix);
                affected.push(row.session_id);
            }
        }
        return { ...this.effective(target, domain, dryRun ? predicted : undefined), applyTo, affectedSessions: affected, affectedCount: affected.length };
    }

    private adjust(target: Target, args: Record<string, unknown>): Record<string, unknown> {
        if (target.scope === "session") return fail("invalid_arguments");
        const action = text(args.action);
        const registry = text(args.registry);
        if (!registries.has(registry)) return fail("invalid_arguments");
        const contracts: Record<string, string[]> = { list: [], get: ["id"], register: ["id", "value"], update: ["id", "value"], remove: ["id"], default_get: ["key"], default_set: ["key", "value"], default_reset: ["key"], link: ["id", "targetId", "relation"], unlink: ["id", "targetId", "relation"] };
        if (!Object.hasOwn(contracts, action)) return fail("invalid_arguments");
        const fields = contracts[action];
        const mutation = !["get", "list", "default_get"].includes(action);
        keys(args, ["action", "registry", "workspaceId", ...fields, ...(mutation ? ["expectedVersion", "dryRun"] : [])], ["action", "registry", ...fields]);
        const prefix = { scope: target.scope, ...(target.workspaceId ? { workspaceId: target.workspaceId } : {}), registry };
        if (action === "list") {
            if (target.workspaceId) return { ...prefix, entries: this.listRegistry(target.workspaceId, registry) };
            const rows = this.db.prepare("SELECT entry_id,value_json,status,version FROM registry_entries WHERE scope_key=? AND registry=? AND status='active' ORDER BY entry_id").all(target.key, registry) as Entry[];
            return { ...prefix, entries: rows.map(row => this.entryView(target, registry, row)) };
        }
        if (action.startsWith("default_")) {
            const key = text(args.key);
            const row = this.db.prepare("SELECT value_json,version FROM registry_defaults WHERE scope_key=? AND registry=? AND default_key=?").get(target.key, registry, key) as Default | undefined;
            const inherited = target.scope === "workspace" ? this.db.prepare("SELECT value_json,version FROM registry_defaults WHERE scope_key='global' AND registry=? AND default_key=?").get(registry, key) as Default | undefined : undefined;
            const effective = row?.value_json && row.value_json !== "null" ? row : inherited;
            if (action === "default_get") return { ...prefix, key, value: effective ? JSON.parse(effective.value_json) : null, version: row?.version ?? 0, source: effective === row ? target.scope : effective ? "global" : null };
            checkVersion(args, row?.version ?? 0);
            const value = action === "default_reset" ? "null" : json(args.value);
            const bumped = nextVersion(row?.version ?? 0);
            if (args.dryRun !== true) {
                this.ensureScope(target);
                this.db.prepare("INSERT INTO registry_defaults(scope_key,registry,default_key,value_json,version,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(scope_key,registry,default_key) DO UPDATE SET value_json=excluded.value_json,version=excluded.version,updated_at=excluded.updated_at").run(target.key, registry, key, value, bumped, new Date().toISOString());
            }
            return { ...prefix, key, value: action === "default_reset" ? inherited ? JSON.parse(inherited.value_json) : null : JSON.parse(value), version: bumped };
        }
        const id = text(args.id);
        const row = this.db.prepare("SELECT entry_id,value_json,status,version FROM registry_entries WHERE scope_key=? AND registry=? AND entry_id=?").get(target.key, registry, id) as Entry | undefined;
        const inherited = !row && target.scope === "workspace" ? this.db.prepare("SELECT entry_id,value_json,status,version FROM registry_entries WHERE scope_key='global' AND registry=? AND entry_id=?").get(registry, id) as Entry | undefined : undefined;
        const effective = row ?? inherited;
        if (action === "get") {
            if (!effective || effective.status !== "active") return fail("not_available");
            const source = row ? target : { scope: "global", key: "global" } as Target;
            return { ...prefix, ...this.entryView(source, registry, effective), version: row?.version ?? 0, effectiveVersion: effective.version, source: source.scope };
        }
        checkVersion(args, row?.version ?? 0);
        if (action === "register" ? row?.status === "active" : !effective || effective.status !== "active") return fail(action === "register" ? "version_conflict" : "not_available");
        const bumped = nextVersion(row?.version ?? 0);
        let value = effective?.value_json ?? "null";
        if (action === "register" || action === "update") {
            if (args.value === null || typeof args.value !== "object" || Array.isArray(args.value)) return fail("invalid_arguments");
            value = json(args.value);
        }
        if (action === "link" || action === "unlink") { text(args.targetId); text(args.relation); }
        if (args.dryRun === true) {
            const base = this.entryView(row ? target : { scope: "global", key: "global" }, registry, { entry_id: id, value_json: value, status: action === "remove" ? "removed" : "active", version: bumped });
            const links = action === "register" || action === "remove" ? [] : base.links as { relation: string; targetId: string }[];
            const filtered = links.filter(link => !(link.relation === args.relation && link.targetId === args.targetId));
            if (action === "link") filtered.push({ relation: args.relation as string, targetId: args.targetId as string });
            return { ...prefix, ...base, links: action === "link" || action === "unlink" ? filtered : links };
        }
        this.ensureScope(target);
        this.db.prepare("INSERT INTO registry_entries(scope_key,registry,entry_id,value_json,status,version,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(scope_key,registry,entry_id) DO UPDATE SET value_json=excluded.value_json,status=excluded.status,version=excluded.version,updated_at=excluded.updated_at").run(target.key, registry, id, value, action === "remove" ? "removed" : "active", bumped, new Date().toISOString());
        if (inherited && action !== "remove" && action !== "register") {
            this.db.prepare("INSERT OR IGNORE INTO registry_links(scope_key,registry,entry_id,relation,target_id) SELECT ?,registry,entry_id,relation,target_id FROM registry_links WHERE scope_key='global' AND registry=? AND entry_id=?").run(target.key, registry, id);
        }
        if (action === "remove" || action === "register") this.db.prepare("DELETE FROM registry_links WHERE scope_key=? AND registry=? AND entry_id=?").run(target.key, registry, id);
        if (action === "link" || action === "unlink") {
            const targetId = text(args.targetId); const relation = text(args.relation);
            if (action === "link") this.db.prepare("INSERT OR IGNORE INTO registry_links(scope_key,registry,entry_id,relation,target_id) VALUES (?,?,?,?,?)").run(target.key, registry, id, relation, targetId);
            else this.db.prepare("DELETE FROM registry_links WHERE scope_key=? AND registry=? AND entry_id=? AND relation=? AND target_id=?").run(target.key, registry, id, relation, targetId);
        }
        return { ...prefix, ...this.entryView(target, registry, { entry_id: id, value_json: value, status: action === "remove" ? "removed" : "active", version: bumped }) };
    }

    private entryView(target: Target, registry: string, row: Entry): Record<string, unknown> {
        const links = this.db.prepare("SELECT relation,target_id FROM registry_links WHERE scope_key=? AND registry=? AND entry_id=? ORDER BY relation,target_id").all(target.key, registry, row.entry_id) as { relation: string; target_id: string }[];
        return { id: row.entry_id, value: JSON.parse(row.value_json), status: row.status, version: row.version, links: links.map(link => ({ relation: link.relation, targetId: link.target_id })) };
    }
}
