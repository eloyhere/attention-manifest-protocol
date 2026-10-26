/**
 * Reference resolution for the construction boundary.
 *
 * A `Ref` is only a pointer. Until it is resolved against a scope, nothing
 * prevents it from naming an object that does not exist — which is how a frame
 * ends up citing a tool, concept or claim that the ledger never held. The table
 * makes resolution explicit and gives the scope a name, so "unresolvable" is a
 * rejection rather than a silent dangling pointer.
 *
 * Canonicalisation rules:
 * - `tool` and `capability` share one namespace; the `mcp.` prefix is transport
 *   detail, not identity.
 * - `self` resolves to the agent id registered for the scope.
 */
import type { Id, Ref, RefKind } from "../types/common.ts";

import { isId } from "./ids.ts";
import { BoundaryRejection } from "../error/boundaryRejection.ts";

/**
 * Where a reference is expected to resolve.
 */
export type RefScope = "run" | "ledger" | "bundle";

/**
 * Kinds that name something outside the ledger. They still need a valid id and
 * a kind, but they cannot be required to resolve here: a human, an org or an
 * external entity lives in a directory the host owns, not in the run.
 */
const DefaultOpaqueKinds: readonly RefKind[] = ["human", "org", "entity", "other"];

const stripToolPrefix = (id: string): string => (id.startsWith("mcp.") ? id.slice(4) : id);

const canonicalId = (kind: RefKind, id: string): string => `${kind}:${kind === "tool" ? stripToolPrefix(id) : id}`;

export class RefTable {
    readonly scope: RefScope;
    readonly opaqueKinds: ReadonlySet<RefKind>;
    private readonly entries: Map<string, unknown>;

    constructor(scope: RefScope, agentId?: string, opaqueKinds: readonly RefKind[] = DefaultOpaqueKinds) {
        this.scope = scope;
        this.opaqueKinds = new Set<RefKind>(opaqueKinds);
        this.entries = new Map<string, unknown>();
        if (agentId !== (void 0)) {
            this.entries.set(`agent:${agentId}`, { kind: "self", id: agentId });
        }
    }

    static forScope(scope: RefScope, agentId?: string, opaqueKinds?: readonly RefKind[]): RefTable {
        return new RefTable(scope, agentId, opaqueKinds);
    }

    /**
     * Register an object under its reference key.
     *
     * @throws BoundaryRejection `invalid_id` when the id cannot be referenced,
     * `duplicate_ref` when the same key is registered twice.
     */
    add(kind: RefKind, id: Id, value: unknown): this {
        if (!isId(id)) {
            throw new BoundaryRejection("invalid_id", [`${kind}:${id} is not a valid AMP id`]);
        }
        const key: string = canonicalId(kind, id);
        if (this.entries.has(key)) {
            throw new BoundaryRejection("duplicate_ref", [`${key} is already registered in scope ${this.scope}`]);
        }
        this.entries.set(key, value);
        return this;
    }

    resolve(ref: Ref): unknown | undefined {
        if (!isId(ref.id)) {
            return (void 0);
        }
        const direct: unknown = this.entries.get(canonicalId(ref.kind, ref.id));
        if (direct !== (void 0)) {
            return direct;
        }
        if (ref.kind === "tool") {
            return this.entries.get(`capability:${stripToolPrefix(ref.id)}`);
        }
        if (ref.kind === "self") {
            return this.entries.get(`agent:${ref.id}`);
        }
        return (void 0);
    }

    /**
     * Resolve or reject. The message names the scope so a host can tell a
     * missing run object from a missing federated object.
     */
    require(ref: Ref): unknown {
        const hit: unknown = this.resolve(ref);
        if (hit === (void 0)) {
            throw new BoundaryRejection("unresolvable_ref", [`${ref.kind}:${ref.id} is not present in scope ${this.scope}`]);
        }
        return hit;
    }

    has(ref: Ref): boolean {
        return this.resolve(ref) !== (void 0);
    }

    /**
     * Resolution verdict used by `frameFrom`.
     *
     * Opaque kinds pass on shape alone; every other kind must be present in the
     * scope. Returns a problem string instead of throwing so callers can report
     * every dangling reference at once.
     */
    check(ref: Ref): string | undefined {
        if (this.opaqueKinds.has(ref.kind)) {
            return (void 0);
        }
        if (this.resolve(ref) !== (void 0)) {
            return (void 0);
        }
        return `${ref.kind}:${ref.id} is not present in scope ${this.scope}`;
    }

    get size(): number {
        return this.entries.size;
    }
}
