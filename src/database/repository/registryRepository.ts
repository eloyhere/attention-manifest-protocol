import type { DatabaseSync } from "node:sqlite";

import type { AttestationEntity, ConceptEntity, ModuleEntity } from "../entity/registry.ts";
import { AttestationTable, ConceptTable, ModuleTable } from "../entity/registry.ts";
import { BaseRepository } from "./base.ts";

/**
 * Concept row joined with its module link.
 */
export interface ModuleConceptRow {
    cid: number;
    id: string;
    role: string;
}

/**
 * Concept registry repository.
 */
export class ConceptRepository extends BaseRepository<ConceptEntity> {
    constructor(db: DatabaseSync) {
        super(db, ConceptTable);
    }

    /**
     * Find a concept by public id.
     *
     * @param id - Public concept id.
     * @returns Concept row, or `undefined`.
     */
    byPublicId(id: string): ConceptEntity | undefined {
        const rows: ConceptEntity[] = this.where("id = ?", id);
        return rows.length === 0 ? (void 0) : rows[0];
    }

    /**
     * Read concepts in one status.
     *
     * @param status - Concept status.
     * @returns Concept rows.
     */
    byStatus(status: string): ConceptEntity[] {
        return this.queries.select({
            where: "status = ?",
            params: [status],
            orderBy: "ORDER BY id ASC",
        });
    }
}

/**
 * Module registry repository.
 */
export class ModuleRepository extends BaseRepository<ModuleEntity> {
    constructor(db: DatabaseSync) {
        super(db, ModuleTable);
    }

    /**
     * Find a module by public id.
     *
     * @param id - Public module id.
     * @returns Module row, or `undefined`.
     */
    byPublicId(id: string): ModuleEntity | undefined {
        const rows: ModuleEntity[] = this.where("id = ?", id);
        return rows.length === 0 ? (void 0) : rows[0];
    }

    /**
     * Read modules of one kind.
     *
     * @param kind - Module kind.
     * @returns Module rows.
     */
    byKind(kind: string): ModuleEntity[] {
        return this.queries.select({
            where: "kind = ?",
            params: [kind],
            orderBy: "ORDER BY id ASC",
        });
    }

    /**
     * Read concepts linked to one module.
     *
     * @param mid - Module id.
     * @returns Joined concept rows.
     */
    concepts(mid: number): ModuleConceptRow[] {
        return this.queries.query<ModuleConceptRow>(
            "SELECT c.cid, c.id, mc.role FROM module_concepts mc JOIN concepts c ON c.cid = mc.cid WHERE mc.mid = ? ORDER BY c.id ASC",
            mid,
        );
    }
}

/**
 * Registry attestation repository.
 */
export class AttestationRepository extends BaseRepository<AttestationEntity> {
    constructor(db: DatabaseSync) {
        super(db, AttestationTable);
    }

    /**
     * Read attestations for one subject.
     *
     * @param subjectKind - Subject kind.
     * @param subjectId - Subject id.
     * @returns Attestation rows.
     */
    forSubject(subjectKind: string, subjectId: string): AttestationEntity[] {
        return this.queries.select({
            where: "subject_kind = ? AND subject_id = ?",
            params: [subjectKind, subjectId],
            orderBy: "ORDER BY aid ASC",
        });
    }
}
