/**
 * Progress: a read-only projection of a process's threads and steps.
 *
 * It is computed from the store, never self-reported. `checkpoint` appends a
 * `progress` object so a supervisor can compare a later view with the committed
 * one instead of trusting the in-memory counter.
 */
import type { DatabaseSync } from "node:sqlite";

import { putObject } from "../database/store/database.ts";

type ProcessRow = {
    state: string;
    used: string;
};

type ThreadStateRow = {
    state: string;
    n: number;
};

type CountRow = {
    n: number;
};

type UsageRow = {
    tokens?: number;
};

export interface ProgressSnapshot {
    pid: number;
    state: string;
    totalThreads: number;
    doneThreads: number;
    failedThreads: number;
    steps: number;
    tokens: number;
    percent: number;
    checkpoint?: string;
}

export const computeProgress: (db: DatabaseSync, pid: number) => ProgressSnapshot = (db: DatabaseSync, pid: number): ProgressSnapshot => {
    const process: ProcessRow | undefined = db.prepare("SELECT state, used FROM processes WHERE pid = ?").get(pid) as ProcessRow | undefined;
    if (process === (void 0)) {
        throw new Error(`unknown process ${pid}`);
    }
    const threads: ThreadStateRow[] = db.prepare("SELECT state, COUNT(*) AS n FROM threads WHERE pid = ? GROUP BY state").all(pid) as ThreadStateRow[];
    const stepRow: CountRow = db.prepare("SELECT COUNT(*) AS n FROM steps WHERE pid = ?").get(pid) as CountRow;
    let total: number = 0;
    let done: number = 0;
    let failed: number = 0;
    for (let index: number = 0; index < threads.length; index += 1) {
        const row: ThreadStateRow = threads[index];
        total += row.n;
        if (row.state === "done") {
            done += row.n;
        }
        if (row.state === "failed") {
            failed += row.n;
        }
    }
    const used: UsageRow = JSON.parse(process.used) as UsageRow;
    return {
        pid,
        state: process.state,
        totalThreads: total,
        doneThreads: done,
        failedThreads: failed,
        steps: stepRow.n,
        tokens: used.tokens ?? 0,
        percent: total === 0 ? 0 : Math.round((done / total) * 1000) / 10,
    };
};

type ProgressCheckpoint = (db: DatabaseSync, pid: number, at: string) => ProgressSnapshot;

/**
 * Append the current view as an immutable `progress` object.
 */
export const checkpointProgress: ProgressCheckpoint = (db: DatabaseSync, pid: number, at: string): ProgressSnapshot => {
    const snapshot: ProgressSnapshot = computeProgress(db, pid);
    const id: string = `pg.${pid}.${snapshot.steps}`;
    putObject(db, "progress", id, { amp: "0.1", kind: "progress", id, at, ...snapshot }, at);
    return { ...snapshot, checkpoint: id };
};
