import type { DatabaseSync } from "node:sqlite";

import type { PrimaryKey } from "../entity/entity.ts";
import type { AttestationEntity, ConceptEntity, ModuleEntity } from "../entity/registry.ts";
import { AttestationRepository, ConceptRepository, ModuleRepository } from "../repository/registryRepository.ts";
import { Service } from "./service.ts";

/**
 * Concept link returned with a module.
 */
export interface ModuleConceptLink {
    cid: number;
    id: string;
    role: string;
}

/**
 * One service per entity: `concepts` in the registry.
 */
export class ConceptService extends Service<ConceptEntity, PrimaryKey, ConceptRepository> {
    private readonly db: DatabaseSync;

    constructor(db: DatabaseSync, concepts: ConceptRepository) {
        super(concepts, "Concept");
        this.db = db;
    }

    byId(cid: number): ConceptEntity | undefined {
        return this.findById(cid);
    }

    byPublicId(id: string): ConceptEntity | undefined {
        return this.repository.byPublicId(id);
    }

    list(status?: string): ConceptEntity[] {
        return status === (void 0) ? this.repository.all() : this.repository.byStatus(status);
    }

    get connection(): DatabaseSync {
        return this.db;
    }
}

/**
 * One service per entity: `modules` in the registry.
 */
export class ModuleService extends Service<ModuleEntity, PrimaryKey, ModuleRepository> {
    private readonly db: DatabaseSync;

    constructor(db: DatabaseSync, modules: ModuleRepository) {
        super(modules, "Module");
        this.db = db;
    }

    byId(mid: number): ModuleEntity | undefined {
        return this.findById(mid);
    }

    byPublicId(id: string): ModuleEntity | undefined {
        return this.repository.byPublicId(id);
    }

    list(kind?: string): ModuleEntity[] {
        return kind === (void 0) ? this.repository.all() : this.repository.byKind(kind);
    }

    concepts(mid: number): ModuleConceptLink[] {
        return this.repository.concepts(mid);
    }

    get connection(): DatabaseSync {
        return this.db;
    }
}

/**
 * One service per entity: `attestations` (evidence links for registry rows).
 */
export class AttestationService extends Service<AttestationEntity, PrimaryKey, AttestationRepository> {
    constructor(attestations: AttestationRepository) {
        super(attestations, "Attestation");
    }

    forSubject(subjectKind: string, subjectId: string): AttestationEntity[] {
        return this.repository.forSubject(subjectKind, subjectId);
    }
}
