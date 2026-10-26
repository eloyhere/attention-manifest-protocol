import type { DatabaseSync } from "node:sqlite";

import type { HandleEntity } from "../entity/handle.ts";
import { HandleTable } from "../entity/handle.ts";
import { BaseRepository } from "./base.ts";

/**
 * Handle/capability repository.
 */
export class HandleRepository extends BaseRepository<HandleEntity> {
    constructor(db: DatabaseSync) {
        super(db, HandleTable);
    }

    /**
     * Read handles granted to one subject.
     *
     * @param kind - Subject kind.
     * @param id - Subject id.
     * @returns Handle rows.
     */
    bySubject(kind: string, id: string): HandleEntity[] {
        return this.queries.select({
            where: "subject_kind = ? AND subject_id = ?",
            params: [kind, id],
            orderBy: "ORDER BY hid ASC",
        });
    }

    /**
     * Read live handles for one subject/resource pair.
     *
     * @param kind - Subject kind.
     * @param id - Subject id.
     * @param resourceKind - Resource kind.
     * @param resourceId - Resource id.
     * @param at - Timestamp used for expiry.
     * @returns Live handle rows.
     */
    liveFor(kind: string, id: string, resourceKind: string, resourceId: string, at: string): HandleEntity[] {
        return this.queries.select({
            where: `subject_kind = ? AND subject_id = ?
                    AND resource_kind = ? AND resource_id = ?
                    AND revoked_at IS NULL
                    AND (expires_at IS NULL OR expires_at > ?)`,
            params: [kind, id, resourceKind, resourceId, at],
            orderBy: "ORDER BY hid ASC",
        });
    }

    /**
     * Read direct children of a parent handle.
     *
     * @param hid - Parent handle id.
     * @returns Child handle rows.
     */
    children(hid: number): HandleEntity[] {
        return this.queries.select({
            where: "parent_hid = ?",
            params: [hid],
            orderBy: "ORDER BY hid ASC",
        });
    }
}
