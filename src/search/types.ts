import type { Client, ClientOptions } from "@elastic/elasticsearch";

/** A host-provided search projection; content is indexed but never returned in hits. */
export interface SearchDocument {
    id: string;
    kind: string;
    title: string;
    summary: string;
    projectId?: string;
    revision?: string;
    sourceUri?: string;
    tags?: string[];
    searchTerms?: string[];
    content?: string;
}

/** Required on every search. Hosts are responsible for authorizing these projects. */
export interface SearchScope {
    projectIds: readonly string[];
    includeGlobal?: boolean;
}

export interface SearchQuery {
    text?: string;
    kinds?: readonly string[];
    tags?: readonly string[];
    revision?: string;
    offset?: number;
    limit?: number;
}

export interface SearchHit {
    document: Omit<SearchDocument, "content">;
    score: number | null;
}

export interface SearchResult {
    hits: SearchHit[];
    total: number;
    totalRelation: "eq" | "gte";
    took: number;
    timedOut: boolean;
}

export interface SearchWriteOptions {
    refresh?: boolean | "wait_for";
}

export interface SearchBulkResult {
    indexed: number;
    failures: { id: string; status: number; reason: string }[];
}

/** Supply exactly one of client or connection, with an explicit endpoint. */
export interface ElasticsearchSearchOptions {
    client?: Client;
    connection?: ClientOptions;
    index?: string;
}
