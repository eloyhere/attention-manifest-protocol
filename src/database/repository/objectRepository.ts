import type { DatabaseSync } from "node:sqlite";

import type { ObjectEntity } from "../entity/object.ts";
import { ObjectTable } from "../entity/object.ts";
import { getObject, putObject } from "../store/database.ts";
import type { PutObjectResult } from "../store/database.ts";
import { BaseRepository } from "./base.ts";

/**
 * Append-only object repository.
 */
export class ObjectRepository extends BaseRepository<ObjectEntity> {
    constructor(db: DatabaseSync) {
        super(db, ObjectTable);
    }

    /**
     * Append one canonical object to the hash chain.
     *
     * @param kind - Object kind.
     * @param id - Object id.
     * @param body - Object body.
     * @param at - Creation timestamp.
     * @returns Sequence and digest.
     */
    put(kind: string, id: string, body: unknown, at: string): PutObjectResult {
        return putObject(this.db, kind, id, body, at);
    }

    /**
     * Find the newest version of one object.
     *
     * @param kind - Object kind.
     * @param id - Object id.
     * @returns The object row, or `undefined`.
     */
    find(kind: string, id: string): ObjectEntity | undefined {
        return getObject(this.db, kind, id);
    }

    /**
     * Read objects of one kind in append order.
     *
     * @param kind - Object kind.
     * @param limit - Maximum rows.
     * @returns Object rows.
     */
    byKind(kind: string, limit: number = 100): ObjectEntity[] {
        return this.queries.select({
            where: "kind = ?",
            params: [kind],
            orderBy: "ORDER BY seq ASC",
            limit,
        });
    }

    /**
     * Read the newest objects across all kinds.
     *
     * @param limit - Maximum rows.
     * @returns Object rows.
     */
    latest(limit: number = 10): ObjectEntity[] {
        return this.queries.select({
            orderBy: "ORDER BY seq DESC",
            limit,
        });
    }
}
