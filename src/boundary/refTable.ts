/**
 * Reference resolution for the construction boundary.
 *
 * A `Ref` is only a pointer. Until it is resolved against a scope, nothing
 * prevents it from naming an object that does not exist — which is how a frame
 * ends up citing a tool, concept or claim that the ledger never held. The table
 * makes resolution explicit and gives the scope a name, so "unresolvable" is a
 * rejection rather than a silent dangling pointer.
 *
 * Canonicalisation rules (one implementation, shared by `add`/`resolve`/`check`):
 * - `tool` and `capability` share one namespace (`capability:<name>`); the
 *   `mcp.` prefix is transport detail, not identity, and only one layer is
 *   stripped. A name that is empty after stripping has no canonical key.
 * - `self` and `agent` share one namespace (`agent:<id>`), which is also how a
 *   constructor-bound agent is registered.
 * - every other kind keeps its own namespace (`<kind>:<id>`).
 */
import type { Id, Ref, RefKind } from "../types/common.ts";

import { isId } from "./ids.ts";
import { isRefKind } from "./kinds.ts";
import { BoundaryRejection } from "../error/boundaryRejection.ts";

/**
 * Where a reference is expected to resolve.
 */
export type RefScope = "run" | "ledger" | "bundle";

const RefScopes: readonly RefScope[] = ["run", "ledger", "bundle"];

/**
 * Kinds that name something outside the ledger. They still need a valid id and
 * a kind, but they cannot be required to resolve here: a human, an org or an
 * external entity lives in a directory the host owns, not in the run.
 */
const DefaultOpaqueKinds: readonly RefKind[] = ["human", "org", "entity", "other"];

const isRefScope: (value: unknown) => value is RefScope = (value: unknown): value is RefScope =>
    typeof(value) === "string" && RefScopes.includes(value as RefScope);

const isRecord: (value: unknown) => value is Record<string, unknown> = (value: unknown): value is Record<string, unknown> =>
    typeof(value) === "object" && value !== null && !Array.isArray(value);

const stripToolPrefix: (id: string) => string = (id: string): string => (id.startsWith("mcp.") ? id.slice(4) : id);

/**
 * The only canonical-key rule. Returns `undefined` when `kind` and `id` do not
 * name a registerable object (a tool/capability id that is empty after the
 * single `mcp.` strip).
 */
const canonicalKey: (kind: RefKind, id: string) => string | undefined = (kind: RefKind, id: string): string | undefined => {
    if (kind === "tool" || kind === "capability") {
        const name: string = stripToolPrefix(id);
        if (name.length === 0) {
            return (void 0);
        }
        return `capability:${name}`;
    }
    if (kind === "self" || kind === "agent") {
        return `agent:${id}`;
    }
    return `${kind}:${id}`;
};

export class RefTable {
    readonly scope: RefScope;
    readonly opaqueKinds: ReadonlySet<RefKind>;
    private readonly entries: Map<string, unknown>;

    /**
     * @throws BoundaryRejection `invalid_ref` for a scope/opaque-kind outside
     * the runtime sets, `invalid_id` for an agent id outside the AMP grammar.
     */
    constructor(scope: RefScope, agentId?: string, opaqueKinds: readonly RefKind[] = DefaultOpaqueKinds) {
        if (!isRefScope(scope)) {
            throw new BoundaryRejection("invalid_ref", [`scope ${String(scope)} is not a ref scope`]);
        }
        if (agentId !== (void 0) && !isId(agentId)) {
            throw new BoundaryRejection("invalid_id", [`agentId ${String(agentId)} is not a valid AMP id`]);
        }
        if (!Array.isArray(opaqueKinds)) {
            throw new BoundaryRejection("invalid_ref", ["opaqueKinds must be an array of ref kinds"]);
        }
        const problems: string[] = [];
        opaqueKinds.forEach((kind: RefKind): void => {
            if (!isRefKind(kind)) {
                problems.push(`${String(kind)} is not a ref kind`);
            }
        });
        if (problems.length > 0) {
            throw new BoundaryRejection("invalid_ref", problems);
        }
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
     * Register an object under its canonical reference key.
     *
     * @throws BoundaryRejection `invalid_ref` for an unknown kind or an
     * `undefined` value, `invalid_id` when the id cannot be referenced,
     * `duplicate_ref` when the same canonical key is registered twice.
     */
    add(kind: RefKind, id: Id, value: unknown): this {
        if (!isRefKind(kind)) {
            throw new BoundaryRejection("invalid_ref", [`${String(kind)} is not a ref kind`]);
        }
        const key: string | undefined = isId(id) ? canonicalKey(kind, id) : (void 0);
        if (key === (void 0)) {
            throw new BoundaryRejection("invalid_id", [`${kind}:${String(id)} is not a valid AMP id`]);
        }
        if (value === (void 0)) {
            throw new BoundaryRejection("invalid_ref", [`${key} cannot be registered with an undefined value`]);
        }
        if (this.entries.has(key)) {
            throw new BoundaryRejection("duplicate_ref", [`${key} is already registered in scope ${this.scope}`]);
        }
        this.entries.set(key, value);
        return this;
    }

    resolve(ref: Ref): unknown | undefined {
        try {
            if (!isRecord(ref)) {
                return (void 0);
            }
            const kind: unknown = ref.kind;
            const id: unknown = ref.id;
            if (!isRefKind(kind) || !isId(id)) {
                return (void 0);
            }
            const key: string | undefined = canonicalKey(kind, id);
            if (key === (void 0)) {
                return (void 0);
            }
            return this.entries.has(key) ? this.entries.get(key) : (void 0);
        } catch {
            return (void 0);
        }
    }

    /**
     * Resolve or reject. The message names the scope so a host can tell a
     * missing run object from a missing federated object. Opaque kinds are not
     * special here: `require` always demands a registered object.
     */
    require(ref: Ref): unknown {
        try {
            if (!isRecord(ref)) {
                throw new BoundaryRejection("invalid_ref", ["value is not a Ref object"]);
            }
            const kind: unknown = ref.kind;
            const id: unknown = ref.id;
            if (!isRefKind(kind)) {
                throw new BoundaryRejection("invalid_ref", [`${String(kind)} is not a ref kind`]);
            }
            if (!isId(id)) {
                throw new BoundaryRejection("invalid_id", [`${kind}:${String(id)} is not a valid AMP id`]);
            }
            const key: string | undefined = canonicalKey(kind, id);
            if (key === (void 0)) {
                throw new BoundaryRejection("invalid_id", [`${kind}:${id} is not a valid AMP id`]);
            }
            if (!this.entries.has(key)) {
                throw new BoundaryRejection("unresolvable_ref", [`${kind}:${id} is not present in scope ${this.scope}`]);
            }
            return this.entries.get(key);
        } catch (error: unknown) {
            if (error instanceof BoundaryRejection) {
                throw error;
            }
            throw new BoundaryRejection("invalid_ref", [`ref could not be inspected (${error instanceof Error ? error.name : typeof(error)})`]);
        }
    }

    has(ref: Ref): boolean {
        return this.resolve(ref) !== (void 0);
    }

    /**
     * Resolution verdict used by `frameFrom`.
     *
     * Every ref must pass the id grammar and the runtime kind set first. Opaque
     * kinds then pass on shape alone; every other kind must be present in the
     * scope. Returns a problem string instead of throwing so callers can report
     * every dangling reference at once.
     */
    check(ref: Ref): string | undefined {
        try {
            if (!isRecord(ref)) {
                return "value is not a Ref object";
            }
            const kind: unknown = ref.kind;
            const id: unknown = ref.id;
            if (!isId(id)) {
                return `${String(kind)}:${String(id)} is not a valid AMP id`;
            }
            if (!isRefKind(kind)) {
                return `${String(kind)} is not a ref kind`;
            }
            const key: string | undefined = canonicalKey(kind, id);
            if (key === (void 0)) {
                return `${kind}:${id} is not a valid AMP id`;
            }
            if (this.opaqueKinds.has(kind)) {
                return (void 0);
            }
            if (this.entries.has(key)) {
                return (void 0);
            }
            return `${kind}:${id} is not present in scope ${this.scope}`;
        } catch (error: unknown) {
            return `ref could not be inspected (${error instanceof Error ? error.name : typeof(error)})`;
        }
    }

    get size(): number {
        return this.entries.size;
    }
}
