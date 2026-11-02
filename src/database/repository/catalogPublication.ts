import type { DatabaseSync } from "node:sqlite";
import { withCatalogWrite } from "../store/catalogGuard.ts";

export interface CatalogPublication { epoch: number; generation: number; index: string | null; digest: string | null; }

/** Only SQLite publishes snapshots; no shared ES alias can be moved by stale writers. */
export class CatalogPublicationRepository {
    private readonly db: DatabaseSync;
    constructor(db: DatabaseSync) { this.db = db; }
    read(namespace: string): CatalogPublication {
        const row = this.db.prepare("SELECT epoch, published_generation, index_name, digest FROM catalog_search_publication WHERE namespace = ?")
            .get(namespace) as { epoch: number; published_generation: number; index_name: string | null; digest: string | null } | undefined;
        return { epoch: row?.epoch ?? 0, generation: row?.published_generation ?? 0, index: row?.index_name ?? null, digest: row?.digest ?? null };
    }
    begin(namespace: string): number {
        return withCatalogWrite(this.db, () => {
            const row = this.db.prepare("INSERT INTO catalog_search_publication(namespace, epoch) SELECT namespace, 1 FROM catalog_sync_state WHERE namespace = ? AND generation > 0 " +
                "ON CONFLICT(namespace) DO UPDATE SET epoch = epoch + 1 RETURNING epoch").get(namespace) as { epoch: number } | undefined;
            if (row === undefined) throw new Error("catalog has no persisted snapshot");
            if (!Number.isSafeInteger(row.epoch)) throw new RangeError("catalog publication epoch overflow");
            return row.epoch;
        });
    }
    publish(namespace: string, epoch: number, generation: number, index: string, digest: string): boolean {
        return withCatalogWrite(this.db, () => {
            this.db.exec("SAVEPOINT catalog_publish");
            try {
                const result = this.db.prepare("UPDATE catalog_search_publication SET published_generation = ?, index_name = ?, digest = ? " +
                    "WHERE namespace = ? AND epoch = ? AND EXISTS (SELECT 1 FROM catalog_sync_state WHERE namespace = ? AND generation = ?)")
                    .run(generation, index, digest, namespace, epoch, namespace, generation);
                if (Number(result.changes) === 1) this.db.prepare("UPDATE catalog_sync_state SET synced_generation = ? WHERE namespace = ? AND generation = ?").run(generation, namespace, generation);
                this.db.exec("RELEASE SAVEPOINT catalog_publish");
                return Number(result.changes) === 1;
            } catch (error) {
                this.db.exec("ROLLBACK TO SAVEPOINT catalog_publish");
                this.db.exec("RELEASE SAVEPOINT catalog_publish");
                throw error;
            }
        });
    }
}
