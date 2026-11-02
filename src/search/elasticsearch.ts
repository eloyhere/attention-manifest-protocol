import { Client, errors } from "@elastic/elasticsearch";
import { createHash, randomUUID } from "node:crypto";
import type { ClientOptions, estypes } from "@elastic/elasticsearch";

import type {
    ElasticsearchSearchOptions,
    SearchBulkResult,
    SearchDocument,
    SearchQuery,
    SearchResult,
    SearchScope,
    SearchWriteOptions,
} from "./types.ts";

const metadataFields = [
    "id", "kind", "title", "summary", "projectId", "revision", "sourceUri", "tags", "searchTerms",
];

function record(value: unknown, name: string): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new TypeError(`${name} must be an object`);
    }
    return value as Record<string, unknown>;
}

function text(value: unknown, name: string, allowEmpty: boolean = false): string {
    if (typeof value !== "string" || (!allowEmpty && value.trim().length === 0)) {
        throw new TypeError(`${name} must be ${allowEmpty ? "a string" : "a nonempty string"}`);
    }
    return value;
}

function documentId(value: unknown): string {
    const id = text(value, "id");
    if (Buffer.byteLength(id, "utf8") > 512) {
        throw new RangeError("id must not exceed 512 UTF-8 bytes");
    }
    return id;
}

function stringArray(value: unknown, name: string): string[] {
    if (!Array.isArray(value)) {
        throw new TypeError(`${name} must be an array of nonempty strings`);
    }
    return Array.from(value, (entry: unknown) => text(entry, name));
}

/** Never copy arbitrary source fields, even from an existing or untrusted index. */
function projectDocument(value: unknown, includeContent: boolean): SearchDocument {
    const source = record(value, "document");
    const document: SearchDocument = {
        id: documentId(source.id),
        kind: text(source.kind, "kind"),
        title: text(source.title, "title"),
        summary: text(source.summary, "summary", true),
    };
    for (const key of ["projectId", "revision", "sourceUri"] as const) {
        if (source[key] !== undefined) document[key] = text(source[key], key);
    }
    for (const key of ["tags", "searchTerms"] as const) {
        if (source[key] !== undefined) document[key] = stringArray(source[key], key);
    }
    if (includeContent && source.content !== undefined) {
        document.content = text(source.content, "content", true);
    }
    return document;
}

function refreshOption(options: SearchWriteOptions | undefined): SearchWriteOptions {
    if (options === undefined) return {};
    const source = record(options, "write options");
    const refresh = source.refresh;
    if (refresh === undefined) return {};
    if (typeof refresh !== "boolean" && refresh !== "wait_for") {
        throw new TypeError("refresh must be a boolean or wait_for");
    }
    return { refresh };
}

function errorStatus(error: unknown): number | undefined {
    if (typeof error !== "object" || error === null) return undefined;
    const value = error as { statusCode?: number; meta?: { statusCode?: number } };
    return value.statusCode ?? value.meta?.statusCode;
}

function errorType(error: unknown): string | undefined {
    if (typeof error !== "object" || error === null) return undefined;
    const value = error as {
        body?: { error?: { type?: string } };
        meta?: { body?: { error?: { type?: string } } };
    };
    return value.body?.error?.type ?? value.meta?.body?.error?.type;
}

function pageInteger(value: unknown, name: string, fallback: number, minimum: number, maximum: number): number {
    if (value === undefined) return fallback;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
        throw new RangeError(`${name} must be an integer between ${minimum} and ${maximum}`);
    }
    return value;
}

export const snapshotDigest = (documents: readonly SearchDocument[]): string => createHash("sha256")
    .update(JSON.stringify([...documents].sort((a, b) => a.id.localeCompare(b.id)).map(document => projectDocument(document, true))))
    .digest("hex");

/** A transport failure cannot prove that Elasticsearch stopped an accepted write. */
export class ElasticsearchWriteOutcomeUnknownError extends Error {
    constructor(cause: unknown) {
        super("Elasticsearch write outcome is unknown; stop synchronization and reconcile server-side tasks before recovery", { cause });
        this.name = "ElasticsearchWriteOutcomeUnknownError";
    }
}

/**
 * Explicit Elasticsearch indexing and scoped search. Construction never sends a request.
 * Namespace ownership is a cooperative marker, not an Elasticsearch authorization boundary.
 * Restrict direct writers with Elasticsearch credentials; privileged writers can alter the marker.
 */
export class ElasticsearchSearch {
    private readonly client: Client;
    private readonly index: string;
    private readonly ownsClient: boolean;
    private namespace: string | undefined;
    private writeStarted = false;
    private uncertainWrite: ElasticsearchWriteOutcomeUnknownError | undefined;

    /** Each attempt writes a fresh index; a timed-out/stale request can only mutate its orphan. */
    async buildSnapshot(namespace: string, documents: readonly SearchDocument[], signal?: AbortSignal): Promise<{ index: string; digest: string }> {
        this.bindNamespace(namespace);
        const projected = Array.from(documents, document => projectDocument(document, true));
        if (new Set(projected.map(document => document.id)).size !== projected.length) throw new TypeError("duplicate document id");
        const prefix = this.index.slice(0, 140);
        const index = `${prefix}-ns-${createHash("sha256").update(namespace).digest("hex").slice(0, 24)}-${randomUUID()}`;
        const child = new ElasticsearchSearch({ client: this.client, index, namespace });
        const active = (): void => signal?.throwIfAborted();
        active();
        // Never adopt a pre-existing index, even one bearing a forged/cooperative marker.
        await child.createSnapshotIndex();
        active();
        for (let offset = 0; offset < projected.length; offset += 1000) {
            const batch = await child.indexDocuments(projected.slice(offset, offset + 1000));
            if (batch.failures.length) throw new Error("Elasticsearch snapshot indexing was incomplete");
            active();
        }
        await this.client.indices.refresh({ index });
        active();
        // addBlock waits for in-flight writes to complete; the published snapshot is immutable.
        await this.client.indices.addBlock({ index, block: "write" }, { maxRetries: 0 });
        active();
        const digest = snapshotDigest(projected);
        await child.verifySnapshot({ index, digest }, projected);
        active();
        return { index, digest };
    }

    private async createSnapshotIndex(): Promise<void> {
        await this.client.indices.create({ index: this.index, settings: { number_of_shards: 1, number_of_replicas: 0 }, mappings: {
            dynamic: "strict", _meta: { amp_search: { version: 1, namespace: this.namespace } },
            properties: { id: { type: "keyword" }, kind: { type: "keyword" }, title: { type: "text" }, summary: { type: "text" },
                projectId: { type: "keyword" }, revision: { type: "keyword" }, sourceUri: { type: "keyword" }, tags: { type: "keyword" }, searchTerms: { type: "text" }, content: { type: "text" } },
        } }, { maxRetries: 0 });
    }

    /** Full bounded verification detects unauthorized documents, overwrites and unsealed indices. */
    private async verifySnapshot(snapshot: { index: string; digest: string }, expected: readonly SearchDocument[]): Promise<void> {
        await this.assertOwnedIndex();
        const settings = await this.client.indices.getSettings({ index: snapshot.index });
        const blocked = settings[snapshot.index]?.settings?.index?.blocks?.write;
        if (blocked !== true && blocked !== "true") throw new Error("catalog snapshot is not write-blocked");
        const count = await this.client.count({ index: snapshot.index });
        if (count.count !== expected.length || count._shards.failed > 0) throw new Error("catalog snapshot document count mismatch");
        const actual: SearchDocument[] = [];
        for (let offset = 0; offset < expected.length; offset += 1000) {
            const ids = expected.slice(offset, offset + 1000).map(document => document.id);
            const found = await this.client.mget<unknown>({ index: snapshot.index, ids });
            for (const doc of found.docs) {
                if (!("found" in doc) || !doc.found || doc._source === undefined) throw new Error("catalog snapshot contains missing documents");
                const projected = projectDocument(doc._source, true);
                if (doc._id !== projected.id) throw new Error("Elasticsearch hit identity mismatch");
                actual.push(projected);
            }
        }
        if (snapshotDigest(actual) !== snapshot.digest || snapshotDigest(expected) !== snapshot.digest) throw new Error("catalog snapshot content digest mismatch");
    }

    async searchSnapshot(namespace: string, snapshot: { index: string; digest: string }, expected: readonly SearchDocument[], scope: SearchScope, query: SearchQuery): Promise<SearchResult> {
        const expectedPrefix = `${this.index.slice(0, 140)}-ns-${createHash("sha256").update(namespace).digest("hex").slice(0, 24)}-`;
        if (!snapshot.index.startsWith(expectedPrefix) || !/^[a-f0-9-]{36}$/.test(snapshot.index.slice(expectedPrefix.length))) throw new Error("catalog snapshot target mismatch");
        const child = new ElasticsearchSearch({ client: this.client, index: snapshot.index, namespace });
        await child.verifySnapshot(snapshot, expected);
        const result = await child.search(scope, query);
        await child.verifySnapshot(snapshot, expected);
        return result;
    }

    constructor(options: ElasticsearchSearchOptions & { namespace?: string }) {
        const source = record(options, "search options");
        if ((source.client === undefined) === (source.connection === undefined)) {
            throw new TypeError("supply exactly one of client or connection");
        }
        const index = source.index === undefined ? "amp-search" : text(source.index, "index");
        if (!/^[a-z0-9][a-z0-9._-]*$/.test(index) || index === "." || index === ".." || Buffer.byteLength(index, "utf8") > 255) {
            throw new TypeError("index must be a concrete lowercase Elasticsearch index name of at most 255 UTF-8 bytes");
        }
        this.index = index;
        if (source.namespace !== undefined) this.bindNamespace(text(source.namespace, "namespace"));
        this.ownsClient = source.client === undefined;
        if (options.client !== undefined) {
            if (options.client === null) throw new TypeError("client must be an Elasticsearch client");
            this.client = options.client;
        } else {
            const connection = record(options.connection, "connection") as ClientOptions;
            if (connection.node === undefined && connection.nodes === undefined && connection.cloud === undefined) {
                throw new TypeError("connection must provide an explicit node, nodes, or cloud endpoint");
            }
            // Startup sniffing would turn construction into an implicit network operation.
            this.client = new Client({ ...connection, sniffOnStart: false });
        }
    }

    /**
     * Bind before writes, normally from the catalog coordinator's constructor.
     * Binding never adopts an existing unmarked index. Recreate/migrate such an index explicitly.
     */
    bindNamespace(namespace: string): void {
        const value = text(namespace, "namespace");
        if (this.namespace === value) return;
        if (this.namespace !== undefined) throw new Error("Elasticsearch index is already bound to another namespace");
        if (this.writeStarted) throw new Error("bind namespace before starting Elasticsearch writes");
        this.namespace = value;
    }

    private assertKnownWriteOutcome(): void {
        if (this.uncertainWrite !== undefined) throw this.uncertainWrite;
    }

    /** Never retry writes: a disconnected or timed-out request may still be running on ES. */
    private async write<T>(operation: () => Promise<T>): Promise<T> {
        this.assertKnownWriteOutcome();
        this.writeStarted = true;
        try {
            return await operation();
        } catch (error: unknown) {
            if (error instanceof errors.TimeoutError || error instanceof errors.ConnectionError || error instanceof errors.RequestAbortedError) {
                this.uncertainWrite = new ElasticsearchWriteOutcomeUnknownError(error);
                throw this.uncertainWrite;
            }
            throw error;
        }
    }

    private async assertOwnedIndex(): Promise<void> {
        this.assertKnownWriteOutcome();
        if (this.namespace === undefined) return;
        await this.assertConcreteIndex();
        const mappings = await this.client.indices.getMapping({ index: this.index });
        const marker = mappings[this.index]?.mappings?._meta?.amp_search;
        if (typeof marker !== "object" || marker === null || marker.version !== 1 || marker.namespace !== this.namespace) {
            throw new Error("Elasticsearch index ownership marker does not match the bound namespace; unmarked indexes require explicit migration");
        }
    }

    private async assertConcreteIndex(): Promise<void> {
        const resolved = await this.client.indices.resolveIndex({ name: this.index, expand_wildcards: "all" });
        if (!Array.isArray(resolved.indices) || resolved.indices.length !== 1 || resolved.indices[0]?.name !== this.index ||
            !Array.isArray(resolved.aliases) || resolved.aliases.length !== 0 ||
            !Array.isArray(resolved.data_streams) || resolved.data_streams.length !== 0) {
            throw new Error("Elasticsearch target must resolve to exactly one concrete index, not an alias or data stream");
        }
    }

    async ensureIndex(): Promise<void> {
        this.assertKnownWriteOutcome();
        if (await this.client.indices.exists({ index: this.index })) {
            await this.assertOwnedIndex();
            return;
        }
        try {
            await this.write(() => this.client.indices.create({
                index: this.index,
                mappings: {
                    ...(this.namespace === undefined ? {} : { _meta: { amp_search: { version: 1, namespace: this.namespace } } }),
                    dynamic: "strict",
                    properties: {
                        id: { type: "keyword" },
                        kind: { type: "keyword" },
                        title: { type: "text" },
                        summary: { type: "text" },
                        projectId: { type: "keyword" },
                        revision: { type: "keyword" },
                        sourceUri: { type: "keyword" },
                        tags: { type: "keyword" },
                        searchTerms: { type: "text" },
                        content: { type: "text" },
                    },
                },
            }, { maxRetries: 0 }));
        } catch (error: unknown) {
            if (errorType(error) !== "resource_already_exists_exception") throw error;
        }
        await this.assertOwnedIndex();
    }

    async indexDocument(document: SearchDocument, options?: SearchWriteOptions): Promise<void> {
        const projected = projectDocument(document, true);
        const refresh = refreshOption(options);
        await this.assertOwnedIndex();
        await this.write(() => this.client.index({
            index: this.index,
            id: projected.id,
            document: projected,
            ...refresh,
        }, { maxRetries: 0 }));
    }

    async indexDocuments(documents: readonly SearchDocument[], options?: SearchWriteOptions): Promise<SearchBulkResult> {
        if (!Array.isArray(documents)) throw new TypeError("documents must be an array");
        if (documents.length > 1000) throw new RangeError("a bulk request must not exceed 1000 documents");
        const refresh = refreshOption(options);
        // Validate every document before starting the single bulk request.
        const projected = Array.from(documents, (document) => projectDocument(document, true));
        if (projected.length === 0) return { indexed: 0, failures: [] };
        const operations: (estypes.BulkOperationContainer | SearchDocument)[] = [];
        for (const document of projected) {
            operations.push({ index: { _index: this.index, _id: document.id } }, document);
        }
        await this.assertOwnedIndex();
        const response = await this.write(() => this.client.bulk<SearchDocument>({ index: this.index, operations, ...refresh }, { maxRetries: 0 }));
        if (response.items.length !== projected.length) {
            throw new Error("Elasticsearch bulk response item count does not match the request");
        }
        const result: SearchBulkResult = { indexed: 0, failures: [] };
        for (const [position, item] of response.items.entries()) {
            const operation = item.index;
            if (operation === undefined) throw new Error("Elasticsearch bulk response is missing an index operation");
            if (!Number.isInteger(operation.status)) {
                throw new Error("Elasticsearch bulk response contains an invalid item status");
            }
            if (operation.error !== undefined || operation.status < 200 || operation.status >= 300) {
                result.failures.push({
                    id: projected[position].id,
                    status: operation.status,
                    reason: operation.error?.reason ?? operation.error?.type ?? `Elasticsearch returned status ${operation.status}`,
                });
            } else {
                result.indexed += 1;
            }
        }
        return result;
    }

    /** Legacy in-place replacement is disabled; buildSnapshot creates isolated indices. */
    async replaceDocuments(documents: readonly SearchDocument[], options?: SearchWriteOptions): Promise<SearchBulkResult> {
        if (!Array.isArray(documents)) throw new TypeError("documents must be an array");
        refreshOption(options);
        const projected = Array.from(documents, (document) => projectDocument(document, true));
        const ids = new Set<string>();
        for (const document of projected) {
            if (ids.has(document.id)) throw new TypeError(`duplicate document id: ${document.id}`);
            ids.add(document.id);
        }
        throw new Error("destructive replacement is disabled; use buildSnapshot");
    }

    async deleteDocument(id: string, options?: SearchWriteOptions): Promise<boolean> {
        const validId = documentId(id);
        const refresh = refreshOption(options);
        await this.assertOwnedIndex();
        try {
            const response = await this.write(() => this.client.delete({ index: this.index, id: validId, ...refresh }, { maxRetries: 0 }));
            return response.result !== "not_found";
        } catch (error: unknown) {
            if (errorStatus(error) === 404 && errorType(error) === "document_missing_exception") return false;
            throw error;
        }
    }

    async search(scope: SearchScope, query: SearchQuery = {}): Promise<SearchResult> {
        const scopeValue = record(scope, "scope");
        const projectIds = stringArray(scopeValue.projectIds, "scope.projectIds");
        if (scopeValue.includeGlobal !== undefined && typeof scopeValue.includeGlobal !== "boolean") {
            throw new TypeError("scope.includeGlobal must be a boolean");
        }
        const queryValue = record(query, "query");
        const offset = pageInteger(queryValue.offset, "offset", 0, 0, 10000);
        const limit = pageInteger(queryValue.limit, "limit", 20, 1, 100);
        if (offset + limit > 10000) throw new RangeError("offset + limit must not exceed 10000");
        const queryText = queryValue.text === undefined ? "" : text(queryValue.text, "text", true).trim();
        const filters: estypes.QueryDslQueryContainer[] = [];
        const scopeAlternatives: estypes.QueryDslQueryContainer[] = [];
        if (projectIds.length > 0) scopeAlternatives.push({ terms: { projectId: projectIds } });
        if (scopeValue.includeGlobal === true) {
            scopeAlternatives.push({ bool: { must_not: [{ exists: { field: "projectId" } }] } });
        }
        for (const [key, field] of [["kinds", "kind"], ["tags", "tags"]] as const) {
            if (queryValue[key] !== undefined) {
                const values = stringArray(queryValue[key], key);
                if (values.length > 0) filters.push({ terms: { [field]: values } });
            }
        }
        if (queryValue.revision !== undefined) {
            filters.push({
                bool: {
                    should: [
                        { term: { revision: text(queryValue.revision, "revision") } },
                        { bool: { must_not: [{ exists: { field: "projectId" } }] } },
                    ],
                    minimum_should_match: 1,
                },
            });
        }
        if (scopeAlternatives.length === 0) {
            return { hits: [], total: 0, totalRelation: "eq", took: 0, timedOut: false };
        }
        filters.unshift({ bool: { should: scopeAlternatives, minimum_should_match: 1 } });
        await this.assertOwnedIndex();
        const response = await this.client.search<unknown>({
            index: this.index,
            from: offset,
            size: limit,
            track_total_hits: true,
            sort: [{ _score: { order: "desc" } }, { id: "asc" }],
            _source: metadataFields.slice(),
            query: {
                bool: {
                    filter: filters,
                    must: [queryText.length > 0 ? {
                        multi_match: {
                            query: queryText,
                            fields: ["title^3", "summary^2", "searchTerms", "content"],
                            operator: "and",
                        },
                    } : { match_all: {} }],
                },
            },
        });
        const failedShards = response._shards?.failed ?? 0;
        if (!Number.isInteger(failedShards) || failedShards < 0) {
            throw new Error("Elasticsearch search response contains an invalid shard failure count");
        }
        if (failedShards > 0) {
            throw new Error(`Elasticsearch search was incomplete: ${failedShards} shard(s) failed`);
        }
        const total = response.hits.total;
        const count = typeof total === "number" ? total : total?.value;
        const relation = typeof total === "number" ? "eq" : total?.relation;
        if (!Number.isSafeInteger(count) || count! < 0 || (relation !== "eq" && relation !== "gte")) {
            throw new Error("Elasticsearch search response contains an invalid total");
        }
        if (!Array.isArray(response.hits.hits) || response.hits.hits.length > limit) {
            throw new Error("Elasticsearch search response exceeds the requested hit limit");
        }
        if (count! < response.hits.hits.length || !Number.isFinite(response.took) || response.took < 0 || typeof response.timed_out !== "boolean") {
            throw new Error("Elasticsearch search response contains invalid result metadata");
        }
        return {
            hits: response.hits.hits.map((hit) => {
                if (hit._score !== undefined && hit._score !== null && !Number.isFinite(hit._score)) {
                    throw new Error("Elasticsearch search response contains an invalid score");
                }
                const document = projectDocument(hit._source, false);
                if (hit._id !== document.id) throw new Error("Elasticsearch hit identity mismatch");
                return { document, score: hit._score ?? null };
            }),
            total: count!,
            totalRelation: relation,
            took: response.took,
            timedOut: response.timed_out,
        };
    }

    /** An injected client remains owned by its host. */
    async close(): Promise<void> {
        if (this.ownsClient) await this.client.close();
    }
}
