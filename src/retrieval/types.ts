import type { Identifier } from "../shared.ts";
import type { Manifest, ToolDefinition } from "../tooling/types.ts";
import type { Optional } from "semantic-typescript";

export type RetrievalStatus = "available" | "missing_precondition" | "disabled";
export interface ToolCandidate extends ToolDefinition {
    readonly endpointId: Identifier;
    readonly tenantId: Identifier;
    readonly manifestId: Identifier;
    readonly status: RetrievalStatus;
    readonly semanticScore?: number;
    readonly signatureCompatibility?: number;
}
export type OptionalValue<V> = Optional<V> | null | undefined;
export interface OptionalLookup<K, V> {
    /** Host indexes may return empty Optional, null, or undefined for a missing key. */
    get(key: K): OptionalValue<V>;
}
export interface CandidateStream {
    readonly manifests: Iterable<Manifest>;
    readonly statusByToolId: OptionalLookup<Identifier, RetrievalStatus>;
    /** Optional scores supplied by the embedding/reranking caller. No embeddings are generated here. */
    readonly semanticScores?: OptionalLookup<Identifier, number>;
    readonly signatureCompatibility?: OptionalLookup<Identifier, number>;
}
export interface RetrievalWeights {
    readonly lexical: number;
    readonly semantic: number;
    readonly signature: number;
}
export interface RetrievalOptions {
    readonly tenantId: Identifier;
    /** Must be computed by the host's authorization layer. Not an authorization decision itself. */
    readonly authorizedToolIds: Iterable<Identifier>;
    readonly query: string;
    readonly limit?: number;
    readonly minimumScore?: number;
    readonly weights?: Partial<RetrievalWeights>;
}
export interface RetrievalQuery {
    readonly tenantId: OptionalValue<Identifier>;
    readonly authorizedToolIds: OptionalValue<Iterable<Identifier>>;
    readonly query: OptionalValue<string>;
    readonly limit?: OptionalValue<number>;
    readonly minimumScore?: OptionalValue<number>;
    readonly weights?: OptionalValue<Partial<RetrievalWeights>>;
}
export interface ScoreBreakdown {
    readonly lexical: number;
    readonly semantic: number;
    readonly signature: number;
    readonly weighted: number;
}
export interface RetrievalReason {
    readonly matchedTerms: readonly string[];
    readonly scores: ScoreBreakdown;
    readonly status: RetrievalStatus;
}
export interface RetrievedTool {
    readonly manifestId: Identifier;
    readonly tool: ToolCandidate;
    readonly score: number;
    readonly reason: RetrievalReason;
}
export interface RetrievalResult {
    readonly tools: readonly RetrievedTool[];
    readonly considered: number;
}

export interface ShapedRecord<T = unknown> {
    readonly summary: string;
    readonly fields?: Readonly<Record<string, unknown>>;
    readonly original: T;
    readonly originalDigest: string;
}
export interface ShapeOptions<T> {
    readonly summary: (value: T) => string;
    readonly digest: (value: T) => string;
    readonly fields?: (value: T) => Readonly<Record<string, unknown>>;
}
export interface Page<T> {
    readonly items: readonly T[];
    readonly nextCursor?: string;
    readonly total: number;
}
export interface HandleScope {
    readonly tenantId: Identifier;
    readonly ownerId: Identifier;
    readonly sessionId: Identifier;
}
export interface RetrievalDataHandle extends HandleScope {
    readonly kind: "retrieval_data";
    readonly id: Identifier;
    readonly sourceDigest: string;
    readonly createdAt: string;
    readonly expiresAt: string;
    readonly revocationEpoch: number;
    readonly revoked: boolean;
}
export interface HandleReadRequest extends HandleScope {
    readonly cursor?: string;
    readonly limit: number;
    readonly now: string;
    readonly expectedRevocationEpoch: number;
}
export type HandleAuthorizer = (handle: RetrievalDataHandle, request: HandleReadRequest) => boolean | Promise<boolean>;
