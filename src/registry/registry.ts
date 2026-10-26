/**
 * Registry: concepts and modules as first-class rows.
 *
 * A directory existing on disk is not evidence that a module is part of the
 * architecture. Declaring it writes an immutable `module.<id>.v<n>` object into
 * the hash chain and updates the current row; the row points at that object, so
 * "this module exists, at version n, with this description" is checkable.
 */
import type { DatabaseSync, SQLOutputValue, StatementResultingChanges } from "node:sqlite";

import type { ConceptEntity, ModuleEntity } from "../database/entity/registry.ts";
import { getObject, putObject, verifyObjectChain } from "../database/store/database.ts";
import type { PutObjectResult } from "../database/store/database.ts";
import { isId } from "../boundary/ids.ts";
import { Stack } from "../structure/stack.ts";
import { UnorderedMap } from "../structure/unordered.ts";
import { UnorderedSet } from "../structure/unordered.ts";

export type RegistryStatus = "proposed" | "active" | "deprecated";
export type ModuleKind = "kernel" | "database" | "domain" | "protocol" | "module" | "structure" | "tool" | "boundary";
export type ConceptLinkRole = "owns" | "uses" | "constrains" | "implements";

export interface ConceptInput {
    id: string;
    label: string;
    definition: string;
    status?: RegistryStatus;
}

export interface ModuleInput {
    id: string;
    kind: ModuleKind;
    entry: string;
    description: string;
    status?: RegistryStatus;
    /**
     * Digest of the directory content at declaration time; enables drift checks.
     */
    contentDigest?: string;
}

export interface DeclarationResult<T> {
    row: T;
    objectId: string;
    hash: string;
}

/**
 * Verification outcome shared by the registry checks.
 */
type VerifyReport = {
    ok: boolean;
    reasons: string[];
};

/**
 * `concept` declaration object written to the hash chain.
 */
type ConceptBody = {
    amp: string;
    kind: string;
    id: string;
    label: string;
    definition: string;
    status: RegistryStatus;
    version: number;
    at: string;
};

/**
 * `module` declaration object written to the hash chain.
 */
type ModuleBody = {
    amp: string;
    kind: string;
    id: string;
    moduleKind: ModuleKind;
    entry: string;
    description: string;
    status: RegistryStatus;
    contentDigest: string | null;
    version: number;
    at: string;
};

/**
 * Subject an attestation points at.
 */
type AttestationSubject = {
    kind: "concept" | "module";
    id: string;
};

/**
 * `evidence` object written for a registry attestation.
 */
type EvidenceBody = {
    amp: string;
    kind: string;
    id: string;
    at: string;
    subject: AttestationSubject;
    claim: string;
    note: string;
};

/**
 * Module primary key, as read from a mid lookup.
 */
type MidRow = {
    mid: number;
};

/**
 * Concept primary key, as read from a cid lookup.
 */
type CidRow = {
    cid: number;
};

/**
 * Module identity row used to build the dependency graph.
 */
type ModuleRefRow = {
    mid: number;
    id: string;
};

/**
 * Dependency edge between two module primary keys.
 */
type DependencyEdgeRow = {
    mid: number;
    depends_on_mid: number;
};

/**
 * Depth-first frame for the dependency cycle walk.
 */
type CycleFrame = {
    id: string;
    next: number;
    neighbors: string[];
};

/**
 * Module row read back for a content-digest comparison.
 */
type ContentDigestRow = {
    id: string;
    entry: string;
    content_digest: string;
};

/**
 * Count returned by an aggregate query.
 */
type CountRow = {
    n: number;
};

/**
 * Concept-or-module row crossing the registry verification union.
 */
type RegistryRow = {
    kind: string;
    id: string;
    version: number;
    object_seq: number | null;
    digest: string | null;
    content_digest: string | null;
};

/**
 * Stored declaration object read back for verification.
 */
type ObjectBodyRow = {
    id: string;
    body: string;
    hash: string;
};

/**
 * Declaration body parsed back out of the object chain.
 */
type DeclaredBody = {
    id?: string;
    version?: number;
    contentDigest?: string | null;
};

/**
 * Attestation row read back for verification.
 */
type AttestationRow = {
    aid: number;
    subject_kind: string;
    subject_id: string;
    claim_id: string;
    object_seq: number | null;
};

/**
 * Signature of the non-empty text guard.
 */
type TextGuard = (value: string, field: string) => void;

const requireText: TextGuard = (value: string, field: string): void => {
    if (value.trim().length === 0) {
        throw new Error(`${field} must not be empty`);
    }
};

/**
 * Signature of the concept declarer.
 */
type ConceptDeclarer = (db: DatabaseSync, input: ConceptInput, at: string) => DeclarationResult<ConceptEntity>;

export const declareConcept: ConceptDeclarer = (db: DatabaseSync, input: ConceptInput, at: string) => {
    if (!isId(input.id)) {
        throw new Error(`concept id ${input.id} is not a valid AMP id`);
    }
    requireText(input.label, "label");
    requireText(input.definition, "definition");
    const existing: ConceptEntity | undefined = db.prepare("SELECT * FROM concepts WHERE id = ?").get(input.id) as unknown as ConceptEntity | undefined;
    const version: number = existing === (void 0) ? 1 : existing.version + 1;
    const objectId: string = `concept.${input.id}.v${version}`;
    const body: ConceptBody = {
        amp: "0.1",
        kind: "concept",
        id: input.id,
        label: input.label,
        definition: input.definition,
        status: input.status ?? "active",
        version,
        at,
    };
    const object: PutObjectResult = putObject(db, "concept", objectId, body, at);
    db.prepare(
        `INSERT INTO concepts (id, label, definition, status, version, object_seq, digest, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           label = excluded.label,
           definition = excluded.definition,
           status = excluded.status,
           version = excluded.version,
           object_seq = excluded.object_seq,
           digest = excluded.digest,
           updated_at = excluded.updated_at`,
    ).run(input.id, input.label, input.definition, input.status ?? "active", version, object.seq, object.hash, existing?.created_at ?? at, at);
    const row: ConceptEntity = db.prepare("SELECT * FROM concepts WHERE id = ?").get(input.id) as unknown as ConceptEntity;
    return { row, objectId, hash: object.hash };
};

/**
 * Signature of the module declarer.
 */
type ModuleDeclarer = (db: DatabaseSync, input: ModuleInput, at: string) => DeclarationResult<ModuleEntity>;

export const declareModule: ModuleDeclarer = (db: DatabaseSync, input: ModuleInput, at: string) => {
    if (!isId(input.id)) {
        throw new Error(`module id ${input.id} is not a valid AMP id`);
    }
    requireText(input.entry, "entry");
    requireText(input.description, "description");
    const existing: ModuleEntity | undefined = db.prepare("SELECT * FROM modules WHERE id = ?").get(input.id) as unknown as ModuleEntity | undefined;
    const version: number = existing === (void 0) ? 1 : existing.version + 1;
    const objectId: string = `module.${input.id}.v${version}`;
    const body: ModuleBody = {
        amp: "0.1",
        kind: "module",
        id: input.id,
        moduleKind: input.kind,
        entry: input.entry,
        description: input.description,
        status: input.status ?? "active",
        contentDigest: input.contentDigest ?? null,
        version,
        at,
    };
    const object: PutObjectResult = putObject(db, "module", objectId, body, at);
    db.prepare(
        `INSERT INTO modules (id, kind, entry, description, status, version, object_seq, digest, content_digest, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           kind = excluded.kind,
           entry = excluded.entry,
           description = excluded.description,
           status = excluded.status,
           version = excluded.version,
           object_seq = excluded.object_seq,
           digest = excluded.digest,
           content_digest = excluded.content_digest,
           updated_at = excluded.updated_at`,
    ).run(
        input.id,
        input.kind,
        input.entry,
        input.description,
        input.status ?? "active",
        version,
        object.seq,
        object.hash,
        input.contentDigest ?? null,
        existing?.created_at ?? at,
        at,
    );
    const row: ModuleEntity = db.prepare("SELECT * FROM modules WHERE id = ?").get(input.id) as unknown as ModuleEntity;
    return { row, objectId, hash: object.hash };
};

/**
 * Signature of the concept-to-module linker.
 */
type ConceptLinker = (db: DatabaseSync, moduleId: string, conceptId: string, role: ConceptLinkRole) => boolean;

export const linkConcept: ConceptLinker = (db: DatabaseSync, moduleId: string, conceptId: string, role: ConceptLinkRole): boolean => {
    const module: MidRow | undefined = db.prepare("SELECT mid FROM modules WHERE id = ?").get(moduleId) as MidRow | undefined;
    if (module === (void 0)) {
        throw new Error(`unknown module ${moduleId}`);
    }
    const concept: CidRow | undefined = db.prepare("SELECT cid FROM concepts WHERE id = ?").get(conceptId) as CidRow | undefined;
    if (concept === (void 0)) {
        throw new Error(`unknown concept ${conceptId}`);
    }
    const result: StatementResultingChanges = db
        .prepare("INSERT OR IGNORE INTO module_concepts (mid, cid, role) VALUES (?, ?, ?)")
        .run(module.mid, concept.cid, role);
    return Number(result.changes) === 1;
};

export interface AttestationResult {
    aid: number;
    objectId: string;
    hash: string;
}

export interface DependencyRow {
    moduleId: string;
    dependsOn: string;
    reason?: string;
}

/**
 * Signature of the module dependency reader.
 */
type DependencyReader = (db: DatabaseSync, moduleId: string) => DependencyRow[];

export const dependencies: DependencyReader = (db: DatabaseSync, moduleId: string): DependencyRow[] => {
    return db
        .prepare(
            `SELECT m.id AS moduleId, d.id AS dependsOn, md.reason AS reason
             FROM module_dependencies md
             JOIN modules m ON m.mid = md.mid
             JOIN modules d ON d.mid = md.depends_on_mid
             WHERE m.id = ? ORDER BY d.id ASC`,
        )
        .all(moduleId) as unknown as DependencyRow[];
};

/**
 * Signature of the module dependency linker.
 */
type DependencyLinker = (db: DatabaseSync, moduleId: string, dependencyId: string, reason?: string) => boolean;

export const linkDependency: DependencyLinker = (db: DatabaseSync, moduleId: string, dependencyId: string, reason: string = ""): boolean => {
    if (moduleId === dependencyId) {
        throw new Error(`module ${moduleId} cannot depend on itself`);
    }
    const module: MidRow | undefined = db.prepare("SELECT mid FROM modules WHERE id = ?").get(moduleId) as MidRow | undefined;
    if (module === (void 0)) {
        throw new Error(`unknown module ${moduleId}`);
    }
    const dependency: MidRow | undefined = db.prepare("SELECT mid FROM modules WHERE id = ?").get(dependencyId) as MidRow | undefined;
    if (dependency === (void 0)) {
        throw new Error(`unknown module ${dependencyId}`);
    }
    const result: StatementResultingChanges = db
        .prepare("INSERT OR IGNORE INTO module_dependencies (mid, depends_on_mid, reason) VALUES (?, ?, ?)")
        .run(module.mid, dependency.mid, reason);
    if (Number(result.changes) === 0) {
        return false;
    }
    if (hasDependencyCycle(db)) {
        db.prepare("DELETE FROM module_dependencies WHERE mid = ? AND depends_on_mid = ?").run(module.mid, dependency.mid);
        throw new Error(`linking ${moduleId} -> ${dependencyId} would create a dependency cycle`);
    }
    return true;
};

/**
 * Signature of the dependency cycle detector.
 */
type CycleDetector = (db: DatabaseSync) => boolean;

/**
 * DFS over the dependency graph; uses the structure library's Stack/Set.
 */
export const hasDependencyCycle: CycleDetector = (db: DatabaseSync): boolean => {
    const modules: ModuleRefRow[] = db.prepare("SELECT mid, id FROM modules").all() as ModuleRefRow[];
    const idByMid: UnorderedMap<number, string> = new UnorderedMap<number, string>();
    for (let index: number = 0; index < modules.length; index += 1) {
        const module: ModuleRefRow = modules[index];
        idByMid.set(module.mid, module.id);
    }
    const edges: DependencyEdgeRow[] = db.prepare("SELECT mid, depends_on_mid FROM module_dependencies").all() as DependencyEdgeRow[];
    const adjacency: UnorderedMap<string, string[]> = new UnorderedMap<string, string[]>();
    for (let index: number = 0; index < edges.length; index += 1) {
        const edge: DependencyEdgeRow = edges[index];
        const from: string | undefined = idByMid.get(edge.mid);
        const to: string | undefined = idByMid.get(edge.depends_on_mid);
        if (from === (void 0) || to === (void 0)) {
            continue;
        }
        const next: string[] = adjacency.get(from) ?? [];
        next.push(to);
        adjacency.set(from, next);
    }

    const visiting: UnorderedSet<string> = new UnorderedSet<string>();
    const visited: UnorderedSet<string> = new UnorderedSet<string>();
    for (let index: number = 0; index < modules.length; index += 1) {
        const module: ModuleRefRow = modules[index];
        if (visited.has(module.id)) {
            continue;
        }
        const stack: Stack<CycleFrame> = new Stack<CycleFrame>();
        stack.push({ id: module.id, next: 0, neighbors: adjacency.get(module.id) ?? [] });
        visiting.add(module.id);
        while (!stack.isEmpty) {
            const frame: CycleFrame | undefined = stack.peek();
            if (frame === (void 0)) {
                break;
            }
            if (frame.next >= frame.neighbors.length) {
                stack.pop();
                visiting.delete(frame.id);
                visited.add(frame.id);
                continue;
            }
            const next: string = frame.neighbors[frame.next];
            frame.next += 1;
            if (visiting.has(next)) {
                return true;
            }
            if (!visited.has(next)) {
                visiting.add(next);
                stack.push({ id: next, next: 0, neighbors: adjacency.get(next) ?? [] });
            }
        }
    }
    return false;
};

/**
 * Signature of the module content verifier.
 */
type ModuleContentVerifier = (db: DatabaseSync, compute: (entry: string) => Promise<string>) => Promise<VerifyReport>;

/**
 * Recompute each module directory's digest and compare it with the declaration.
 */
export const verifyModuleContent: ModuleContentVerifier = async (db: DatabaseSync, compute: (entry: string) => Promise<string>) => {
    const reasons: string[] = [];
    const rows: ContentDigestRow[] = db
        .prepare("SELECT id, entry, content_digest FROM modules WHERE content_digest IS NOT NULL ORDER BY id ASC")
        .all() as ContentDigestRow[];
    for (let index: number = 0; index < rows.length; index += 1) {
        const row: ContentDigestRow = rows[index];
        const actual: string = await compute(row.entry);
        if (actual !== row.content_digest) {
            reasons.push(`module ${row.id}: content changed since declaration`);
        }
    }
    return { ok: reasons.length === 0, reasons };
};

/**
 * Signature of the registry attester.
 */
type Attester = (db: DatabaseSync, subjectKind: "concept" | "module", subjectId: string, claimId: string, at: string) => AttestationResult;

/**
 * Attest a registry row with a claim. The attestation is an `evidence` object
 * in the chain plus a row that points at it, so a module can be justified by
 * something stronger than "the directory exists".
 */
export const attest: Attester = (db: DatabaseSync, subjectKind: "concept" | "module", subjectId: string, claimId: string, at: string) => {
    const subject: Record<string, SQLOutputValue> | undefined =
        subjectKind === "module"
            ? db.prepare("SELECT mid FROM modules WHERE id = ?").get(subjectId)
            : db.prepare("SELECT cid FROM concepts WHERE id = ?").get(subjectId);
    if (subject === (void 0)) {
        throw new Error(`unknown ${subjectKind} ${subjectId}`);
    }
    if (getObject(db, "claim", claimId) === (void 0)) {
        throw new Error(`unknown claim ${claimId}`);
    }
    const count: CountRow = db
        .prepare("SELECT COUNT(*) AS n FROM attestations WHERE subject_kind = ? AND subject_id = ?")
        .get(subjectKind, subjectId) as CountRow;
    const objectId: string = `ev.registry.${subjectKind}.${subjectId}.${count.n + 1}`;
    const body: EvidenceBody = {
        amp: "0.1",
        kind: "evidence",
        id: objectId,
        at,
        subject: { kind: subjectKind, id: subjectId },
        claim: claimId,
        note: `registry attestation for ${subjectKind} ${subjectId}`,
    };
    const object: PutObjectResult = putObject(db, "evidence", objectId, body, at);
    const result: StatementResultingChanges = db
        .prepare("INSERT INTO attestations (subject_kind, subject_id, claim_id, object_seq, at) VALUES (?, ?, ?, ?, ?)")
        .run(subjectKind, subjectId, claimId, object.seq, at);
    return { aid: Number(result.lastInsertRowid), objectId, hash: object.hash };
};

/**
 * Signature of the registry verifier.
 */
type RegistryVerifier = (db: DatabaseSync) => VerifyReport;

export const verifyRegistry: RegistryVerifier = (db: DatabaseSync): VerifyReport => {
    const reasons: string[] = [...verifyObjectChain(db).reasons];

    const rows: RegistryRow[] = db
        .prepare(
            `SELECT 'concept' AS kind, id, version, object_seq, digest, NULL AS content_digest FROM concepts
             UNION ALL
             SELECT 'module', id, version, object_seq, digest, content_digest FROM modules`,
        )
        .all() as RegistryRow[];
    for (let index: number = 0; index < rows.length; index += 1) {
        const row: RegistryRow = rows[index];
        if (row.object_seq === null) {
            reasons.push(`${row.kind} ${row.id}: no declaration object`);
            continue;
        }
        const object: ObjectBodyRow | undefined = db.prepare("SELECT id, body, hash FROM objects WHERE seq = ?").get(row.object_seq) as
            ObjectBodyRow | undefined;
        if (object === (void 0)) {
            reasons.push(`${row.kind} ${row.id}: declaration object is missing`);
            continue;
        }
        const body: DeclaredBody = JSON.parse(object.body) as DeclaredBody;
        if (body.id !== row.id) {
            reasons.push(`${row.kind} ${row.id}: object id is ${`${body.id}`}`);
        }
        if (body.version !== row.version) {
            reasons.push(`${row.kind} ${row.id}: object version ${`${body.version}`} != row ${row.version}`);
        }
        if (row.digest !== null && row.digest !== object.hash) {
            reasons.push(`${row.kind} ${row.id}: digest does not match the object`);
        }
        if ((body.contentDigest ?? null) !== row.content_digest) {
            reasons.push(`${row.kind} ${row.id}: content digest does not match the declaration object`);
        }
    }

    const danglingLinks: CountRow = db
        .prepare(
            "SELECT COUNT(*) AS n FROM module_concepts mc LEFT JOIN modules m ON m.mid = mc.mid LEFT JOIN concepts c ON c.cid = mc.cid WHERE m.mid IS NULL OR c.cid IS NULL",
        )
        .get() as CountRow;
    if (danglingLinks.n > 0) {
        reasons.push(`${danglingLinks.n} module_concepts link(s) point at missing rows`);
    }

    const danglingDependencies: CountRow = db
        .prepare(
            `SELECT COUNT(*) AS n FROM module_dependencies md
             LEFT JOIN modules m ON m.mid = md.mid
             LEFT JOIN modules d ON d.mid = md.depends_on_mid
             WHERE m.mid IS NULL OR d.mid IS NULL`,
        )
        .get() as CountRow;
    if (danglingDependencies.n > 0) {
        reasons.push(`${danglingDependencies.n} module_dependencies link(s) point at missing rows`);
    }
    if (hasDependencyCycle(db)) {
        reasons.push("module dependency graph contains a cycle");
    }

    const attestations: AttestationRow[] = db
        .prepare("SELECT aid, subject_kind, subject_id, claim_id, object_seq FROM attestations ORDER BY aid ASC")
        .all() as AttestationRow[];
    for (let index: number = 0; index < attestations.length; index += 1) {
        const attestation: AttestationRow = attestations[index];
        if (attestation.object_seq === null || db.prepare("SELECT seq FROM objects WHERE seq = ?").get(attestation.object_seq) === (void 0)) {
            reasons.push(`attestation ${attestation.aid}: evidence object is missing`);
        }
        if (getObject(db, "claim", attestation.claim_id) === (void 0)) {
            reasons.push(`attestation ${attestation.aid}: claim ${attestation.claim_id} is missing`);
        }
    }

    return { ok: reasons.length === 0, reasons };
};
