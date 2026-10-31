import type { DatabaseSync } from "node:sqlite";

import type { WindowEntity, WindowPageEntity } from "../entity/window.ts";
import { WindowPageTable, WindowTable } from "../entity/window.ts";
import { TableSql } from "../sql/sql.ts";
import { BaseRepository } from "./base.ts";

/**
 * Input row for replacing a window's page set.
 */
export interface WindowPageInput {
    pageId: string;
    objectKind: string;
    objectId: string;
    tokens: number;
    pinned: boolean;
    lastUsed: number;
}

/**
 * Context-window repository.
 */
export class WindowRepository extends BaseRepository<WindowEntity> {
    private readonly pagesSql: TableSql<WindowPageEntity>;

    constructor(db: DatabaseSync) {
        super(db, WindowTable);
        this.pagesSql = new TableSql<WindowPageEntity>(db, WindowPageTable);
    }

    /**
     * Read resident pages for one thread, least recently used first.
     *
     * @param tid - Thread id.
     * @returns Page rows.
     */
    pages(tid: number): WindowPageEntity[] {
        return this.pagesSql.select({
            where: "tid = ?",
            params: [tid],
            orderBy: "ORDER BY last_used ASC",
        });
    }

    /**
     * Insert or update the window totals.
     *
     * @param tid - Thread id.
     * @param capacityTokens - Token capacity.
     * @param usedTokens - Used tokens.
     * @param at - Update timestamp.
     */
    save(tid: number, capacityTokens: number, usedTokens: number, at: string): void {
        this.upsert({
            tid,
            capacity_tokens: capacityTokens,
            used_tokens: usedTokens,
            updated_at: at,
        });
    }

    /**
     * Replace the page table for one thread; call inside a transaction.
     *
     * @param tid - Thread id.
     * @param pages - New page set.
     * @param at - Update timestamp.
     * @param capacityTokens - Token capacity.
     */
    replacePages(tid: number, pages: readonly WindowPageInput[], at: string, capacityTokens: number): void {
        this.pagesSql.deleteWhere("tid = ?", tid);
        let used: number = 0;
        for (let index: number = 0; index < pages.length; index += 1) {
            const page: WindowPageInput = pages[index];
            this.pagesSql.insert({
                tid,
                page_id: page.pageId,
                object_kind: page.objectKind,
                object_id: page.objectId,
                tokens: page.tokens,
                pinned: page.pinned,
                last_used: page.lastUsed,
            });
            used += page.tokens;
        }
        this.save(tid, capacityTokens, used, at);
    }
}
