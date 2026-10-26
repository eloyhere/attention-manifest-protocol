/**
 * Process: a persistent agent.
 *
 * The process is the agent itself: it owns a budget, a memory (address space),
 * capabilities and a parent (for delegated sub-agents). It does not "complete";
 * it moves between created/running/idle/suspended/terminated while tasks come
 * and go. A task is a thread (see `src/thread`), so one agent does one thing at
 * a time, like a CPU running one thread.
 */
import type { DatabaseSync } from "node:sqlite";

import type { Budget, Id, Usage } from "../types/common.ts";
import { isId } from "../boundary/ids.ts";
import { KernelError } from "../error/kernelError.ts";
import { putObject } from "../database/store/database.ts";
import { requirePermission } from "../authz/authz.ts";
import type { Subject } from "../authz/authz.ts";
import { ExecutionRepository } from "../database/repository/executionRepository.ts";
import { AddressSpaceRepository } from "../database/repository/addressSpaceRepository.ts";

export { canProcessTransition } from "./transitions.ts";

export type ProcessState = "created" | "running" | "idle" | "suspended" | "terminated";

export interface ProcessSpec {
    id: Id;
    /** Display name of the agent. */
    name: string;
    role?: string;
    priority?: number;
    budget?: Budget;
    parentPid?: number;
}

export interface ProcessRecord {
    pid: number;
    id: Id;
    name: string;
    role?: string;
    state: ProcessState;
    priority: number;
    budget: Budget;
    used: Usage;
    parentPid?: number;
    createdAt: string;
    startedAt?: string;
    terminatedAt?: string;
    exitCode?: string;
    exitNote?: string;
}

export interface ProcessPatch {
    startedAt?: string;
    terminatedAt?: string;
    exitCode?: string;
    exitNote?: string;
}

/** Agent lifecycle. `terminated` has no outgoing edge. */
export const emptyUsage = (): Required<Pick<Usage, "tokens" | "ms" | "calls" | "interrupts" | "money">> => ({
    tokens: 0,
    ms: 0,
    calls: 0,
    interrupts: 0,
    money: 0,
});

export const createProcess = (db: DatabaseSync, spec: ProcessSpec, at: string): ProcessRecord => {
    if (!isId(spec.id)) throw new KernelError("invalid_process", [`id ${spec.id} is not a valid AMP id`]);
    if (spec.name.trim().length === 0) throw new KernelError("invalid_process", ["name is empty"]);
    return new ExecutionRepository(db).createAgent(spec, at);
};

export const findProcess = (db: DatabaseSync, id: Id): ProcessRecord | undefined => new ExecutionRepository(db).findAgentByExternalId(id);

export const getProcess = (db: DatabaseSync, pid: number): ProcessRecord => new ExecutionRepository(db).getAgent(pid);

export const listProcesses = (db: DatabaseSync, state?: ProcessState): ProcessRecord[] => new ExecutionRepository(db).listAgents(state);

/** Guarded agent transition. The update only applies from one of `from`. */
export const transitionProcess = (
    db: DatabaseSync,
    pid: number,
    from: ProcessState | ProcessState[],
    to: ProcessState,
    patch: ProcessPatch = {},
): ProcessRecord => new ExecutionRepository(db).transitionAgent(pid, from, to, patch);

/**
 * Charge the agent's overall budget. Exhaustion suspends the agent (it can be
 * resumed with a larger budget); it does not silently drop the task.
 */
export const chargeProcess = (db: DatabaseSync, pid: number, usage: Budget, at: string): { ok: boolean; exceeded: string[] } =>
    new ExecutionRepository(db).chargeAgent(pid, usage, at);

export const terminateProcess = (db: DatabaseSync, pid: number, note: string, at: string, code = "TERMINATED"): ProcessRecord => {
    return transitionProcess(db, pid, ["created", "running", "idle", "suspended"], "terminated", { terminatedAt: at, exitCode: code, exitNote: note });
};

/* ----------------------------- address space ----------------------------- */

export type AddressRole = "own" | "inherited" | "mapped" | "joined";
export type AddressMode = "read" | "write";

export interface ProcessObjectRecord {
    seq: number;
    kind: string;
    id: string;
    body: string;
    role: AddressRole;
    mode: AddressMode;
}

/**
 * Map an immutable object into an agent's memory.
 *
 * `own` is writable, `inherited` is the read-only copy-on-write view a fork
 * gets, `mapped`/`joined` are cross-agent views. Mapped reads need a capability
 * unless the caller is the owner.
 */
export const attachObject = (db: DatabaseSync, pid: number, seq: number, role: AddressRole, mode: AddressMode, at: string, subject?: Subject): void => {
    getProcess(db, pid);
    const address = new AddressSpaceRepository(db);
    if (!address.hasObject(seq)) throw new KernelError("unknown_object", [`seq ${seq} is not in the object store`]);
    if (subject !== undefined) {
        requirePermission(db, subject, mode === "write" ? "write" : "read", { kind: "object", id: `${seq}`, ownerPid: pid }, at);
    }
    address.attach(pid, seq, role, mode, at);
};

export const processObjects = (db: DatabaseSync, pid: number): ProcessObjectRecord[] => new AddressSpaceRepository(db).list(pid);

export const readProcessObject = (db: DatabaseSync, pid: number, seq: number, subject: Subject, at: string): ProcessObjectRecord => {
    const row = new AddressSpaceRepository(db).read(pid, seq);
    if (row === undefined) throw new KernelError("unknown_object", [`seq ${seq} is not mapped into pid ${pid}`]);
    if (row.role === "own" || row.role === "inherited" || row.role === "joined") return row;
    requirePermission(db, subject, "read", { kind: "object", id: `${seq}` }, at);
    return row;
};

export const writeProcessObject = (db: DatabaseSync, pid: number, seq: number, subject: Subject, at: string): ProcessObjectRecord => {
    const row = readProcessObject(db, pid, seq, subject, at);
    if (row.mode !== "write") {
        requirePermission(db, subject, "write", { kind: "object", id: `${seq}` }, at);
    }
    return row;
};

/** Fork a delegated sub-agent with a read-only view of the parent's memory. */
export const forkProcess = (db: DatabaseSync, parentPid: number, spec: ProcessSpec, at: string, subject?: Subject): ProcessRecord => {
    const parent = getProcess(db, parentPid);
    if (subject !== undefined) {
        requirePermission(db, subject, "fork", { kind: "process", id: parent.id, ownerPid: parentPid }, at);
    }
    const child = createProcess(db, { ...spec, parentPid }, at);
    new AddressSpaceRepository(db).fork(parentPid, child.pid, at);
    return child;
};

/** Join a sub-agent back: its own objects become read-only pages in the parent. */
export const joinProcess = (db: DatabaseSync, childPid: number, parentPid: number, at: string, subject?: Subject): number => {
    const child = getProcess(db, childPid);
    if (child.parentPid !== parentPid) throw new KernelError("invalid_transition", [`pid ${childPid} is not a child of ${parentPid}`]);
    if (subject !== undefined) {
        requirePermission(db, subject, "join", { kind: "process", id: child.id, ownerPid: parentPid }, at);
    }
    const result = new AddressSpaceRepository(db).join(parentPid, childPid, at);
    terminateProcess(db, childPid, `joined into ${parentPid}`, at, "JOINED");
    return result;
};

/** Append a claim/event/frame object inside the same transaction as the step. */
export const putProcessObject = (db: DatabaseSync, kind: string, id: Id, body: unknown, at: string): { seq: number; hash: string } => {
    return putObject(db, kind, id, body, at);
};
