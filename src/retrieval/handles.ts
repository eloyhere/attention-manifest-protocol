import { isNumber, isString, SynchronousOrderedMap } from "semantic-typescript";
import type { Identifier } from "../shared.ts";
import type { HandleAuthorizer, HandleReadRequest, HandleScope, Page, RetrievalDataHandle } from "./types.ts";
import { paginate } from "./shaper.ts";

interface StoredHandle<T> {
    readonly handle: RetrievalDataHandle;
    readonly digest: string;
    readonly records: readonly T[];
}

const parsedTime = (value: string, name: string): number => {
    if (!isString(value)) throw new TypeError(`${name} must be a timestamp string`);
    const time = Date.parse(value);
    if (!Number.isFinite(time)) throw new TypeError(`${name} must be a valid timestamp`);
    return time;
};

/** In-memory handle index. Raw retrieval is gated by host authorization on every read. */
export class RetrievalHandleStore<T> {
    private readonly handles = new SynchronousOrderedMap<Identifier, StoredHandle<T>>();
    private readonly clock: () => string;

    constructor(clock: () => string = () => new Date().toISOString()) { this.clock = clock; }

    create(input: HandleScope & { id: Identifier; sourceDigest: string; ttlMilliseconds: number; revocationEpoch: number; records: readonly T[] }): RetrievalDataHandle {
        if (!input.id || !input.tenantId || !input.ownerId || !input.sessionId || !input.sourceDigest) throw new TypeError("handle scope and source digest are required");
        if (!isNumber(input.ttlMilliseconds) || !Number.isSafeInteger(input.ttlMilliseconds) || input.ttlMilliseconds <= 0) throw new RangeError("ttlMilliseconds must be positive");
        if (!isNumber(input.revocationEpoch) || !Number.isSafeInteger(input.revocationEpoch) || input.revocationEpoch < 0) throw new RangeError("revocationEpoch must be nonnegative");
        if (this.handles.containsKey(input.id)) throw new TypeError("duplicate handle id");
        const createdAt = this.clock();
        const expiresAt = new Date(parsedTime(createdAt, "createdAt") + input.ttlMilliseconds).toISOString();
        const handle: RetrievalDataHandle = { kind: "retrieval_data", id: input.id, tenantId: input.tenantId, ownerId: input.ownerId,
            sessionId: input.sessionId, sourceDigest: input.sourceDigest, revocationEpoch: input.revocationEpoch,
            createdAt, expiresAt, revoked: false };
        this.handles.put(handle.id, { handle, digest: input.sourceDigest, records: structuredClone(input.records) });
        return structuredClone(handle);
    }

    async read(id: Identifier, request: HandleReadRequest, authorize: HandleAuthorizer): Promise<Page<T>> {
        const stored = this.lookup(id);
        const handle = stored.handle;
        this.assertReadable(handle, request);
        if (!await authorize(structuredClone(handle), request)) throw new Error("handle_forbidden");
        // Authorization may yield; a concurrent revoke must win before data is released.
        const latest = this.lookup(id);
        if (latest.handle.revoked || latest.handle.revocationEpoch !== handle.revocationEpoch) throw new Error("handle_revoked");
        this.assertReadable(latest.handle, request);
        return paginate(latest.records, request.cursor, request.limit);
    }

    revoke(id: Identifier): void {
        const stored = this.lookup(id);
        if (stored.handle.revoked) return;
        this.handles.put(id, { ...stored, handle: { ...stored.handle, revocationEpoch: stored.handle.revocationEpoch + 1, revoked: true } });
    }

    getHandle(id: Identifier): RetrievalDataHandle | undefined {
        const value = this.handles.get(id);
        return value.isEmpty() ? undefined : structuredClone(value.get().handle);
    }

    private lookup(id: Identifier): StoredHandle<T> {
        const value = this.handles.get(id);
        if (value.isEmpty()) throw new Error("handle_not_found");
        return value.get();
    }

    private assertReadable(handle: RetrievalDataHandle, request: HandleReadRequest): void {
        if (request.tenantId !== handle.tenantId || request.ownerId !== handle.ownerId || request.sessionId !== handle.sessionId) throw new Error("handle_scope_mismatch");
        const now = parsedTime(request.now, "request.now");
        const expiresAt = parsedTime(handle.expiresAt, "handle.expiresAt");
        if (now >= expiresAt) throw new Error("handle_expired");
        if (handle.revoked || request.expectedRevocationEpoch !== handle.revocationEpoch) throw new Error("handle_revoked");
    }
}
