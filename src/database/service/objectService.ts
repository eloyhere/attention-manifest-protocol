import type { DatabaseSync } from "node:sqlite";

import type { PrimaryKey } from "../entity/entity.ts";
import type { ObjectEntity } from "../entity/object.ts";
import { ObjectRepository } from "../repository/objectRepository.ts";
import { verifyObjectChain } from "../store/database.ts";
import { Service } from "./service.ts";

/**
 * Result of appending an object to the hash chain.
 */
export interface ObjectPutResult {
    seq: number;
    hash: string;
}

/**
 * Result of verifying the object hash chain.
 */
export interface ObjectVerifyResult {
    ok: boolean;
    reasons: string[];
}

/**
 * One service per entity: `objects`.
 */
export class ObjectService extends Service<ObjectEntity, PrimaryKey, ObjectRepository> {
    private readonly db: DatabaseSync;

    constructor(db: DatabaseSync, objects: ObjectRepository) {
        super(objects, "Object");
        this.db = db;
    }

    put(kind: string, id: string, body: unknown, at: string): ObjectPutResult {
        return this.repository.put(kind, id, body, at);
    }

    get(kind: string, id: string): ObjectEntity | undefined {
        return this.repository.find(kind, id);
    }

    byId(seq: number): ObjectEntity | undefined {
        return this.findById(seq);
    }

    byKind(kind: string, limit = 100): ObjectEntity[] {
        return this.repository.byKind(kind, limit);
    }

    latest(limit = 10): ObjectEntity[] {
        return this.repository.latest(limit);
    }

    verify(): ObjectVerifyResult {
        return verifyObjectChain(this.db);
    }
}
