import type { DatabaseSync } from "node:sqlite";

import type { PrimaryKey } from "../entity/entity.ts";
import type { HandleEntity } from "../entity/handle.ts";
import { HandleRepository } from "../repository/handleRepository.ts";
import { grant, listCapabilities, revoke } from "../../authz/authz.ts";
import type { CapabilityRecord, GrantInput, Subject } from "../../authz/authz.ts";
import { Service } from "./service.ts";

/**
 * One service per entity: `handles`.
 */
export class HandleService extends Service<HandleEntity, PrimaryKey, HandleRepository> {
    private readonly db: DatabaseSync;

    constructor(db: DatabaseSync, handles: HandleRepository) {
        super(handles, "Handle");
        this.db = db;
    }

    byId(hid: number): HandleEntity | undefined {
        return this.findById(hid);
    }

    bySubject(kind: string, id: string): HandleEntity[] {
        return this.repository.bySubject(kind, id);
    }

    liveFor(kind: string, id: string, resourceKind: string, resourceId: string, at: string): HandleEntity[] {
        return this.repository.liveFor(kind, id, resourceKind, resourceId, at);
    }

    children(hid: number): HandleEntity[] {
        return this.repository.children(hid);
    }

    list(subject: Subject): CapabilityRecord[] {
        return listCapabilities(this.db, subject);
    }

    grant(input: GrantInput, at: string): CapabilityRecord {
        return grant(this.db, input, at);
    }

    revoke(subject: Subject, hid: number, at: string): number {
        return revoke(this.db, subject, hid, at);
    }
}
