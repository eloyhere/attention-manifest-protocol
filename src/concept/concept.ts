/**
 * AMP v0.1 — Concept: a compressed pattern that can occupy one attention slot.
 * Mirrors docs/schemas/concept.schema.json.
 */
import type { Confidence, Id, Provenance, Ref, Timestamp } from "../types/common.ts";

export type ConceptStatus = "proposed" | "active" | "deprecated" | "merged" | "split";

export interface ConceptFeature {
    feature: string;
    weight?: Confidence;
}

export interface ConceptDimension {
    name: string;
    scale?: "nominal" | "ordinal" | "interval" | "ratio";
}

export type ConceptRelationType = "is-a" | "part-of" | "causes" | "enables" | "contrasts-with" | "derived-from" | "precedes";

export interface ConceptRelation {
    type: ConceptRelationType;
    target: Ref;
}

export interface ConceptExample {
    ref?: Ref;
    description: string;
    typicality?: Confidence;
}

/**
 * Operations are recorded, never applied in place.
 */
export interface ConceptRevision {
    op: "merge" | "split" | "refine" | "retire";
    at: Timestamp;
    from?: Ref[];
    reason?: string;
}

export interface Concept {
    amp: "0.1";
    kind: "concept";
    id: Id;
    label: string;
    definition: string;
    /**
     * Defining features (prototype-style, graded — not an OWL class expression).
     */
    intension: ConceptFeature[];
    /**
     * Conceptual-space dimensions, when the concept is geometric rather than featural.
     */
    dimensions?: ConceptDimension[];
    /**
     * Anti-vacuity: external theory this concept is answerable to.
     */
    theory_refs?: string[];
    extension?: Ref[];
    prototype?: string;
    /**
     * Grounding: at least one real instance. A concept with none is a label.
     */
    examples?: ConceptExample[];
    counterexamples?: ConceptExample[];
    relations?: ConceptRelation[];
    grounded_in?: Ref[];
    status: ConceptStatus;
    confidence: Confidence;
    provenance: Provenance;
    version: number;
    created: Timestamp;
    revision?: ConceptRevision;
}
