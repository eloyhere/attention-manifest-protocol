/**
 * JPA-style entity lifecycle callbacks and state transitions.
 *
 * The metadata layer describes what is persisted; this module describes when a
 * host may run callbacks around that work. It is deliberately side-effect free:
 * callbacks receive the entity and a small context and cannot return a
 * replacement entity. Persistence itself stays in `Store`/repositories.
 */

import { isEntityKind } from "./key.ts";
import type { EntityKind, EntityState } from "./types.ts";

/** Callbacks defined by JPA around the persistence context (`@PrePersist`, ...). */
export type EntityLifecycleEvent =
    | "prePersist"
    | "postPersist"
    | "preUpdate"
    | "postUpdate"
    | "preRemove"
    | "postRemove"
    | "postLoad";

export const ENTITY_LIFECYCLE_EVENTS: readonly EntityLifecycleEvent[] = Object.freeze([
    "prePersist",
    "postPersist",
    "preUpdate",
    "postUpdate",
    "preRemove",
    "postRemove",
    "postLoad",
]);

/** Runtime mirror of `EntityState`, including the terminal `deleted` alias. */
export const ENTITY_STATES: readonly EntityState[] = Object.freeze([
    "new",
    "managed",
    "detached",
    "removed",
    "deleted",
]);

export function isEntityState(value: unknown): value is EntityState {
    return typeof value === "string" && (ENTITY_STATES as readonly string[]).includes(value);
}

export function isEntityLifecycleEvent(value: unknown): value is EntityLifecycleEvent {
    return typeof value === "string" && (ENTITY_LIFECYCLE_EVENTS as readonly string[]).includes(value);
}

export function assertEntityState(value: unknown, label = "entity state"): asserts value is EntityState {
    if (!isEntityState(value)) throw new TypeError(`${label} is not a known entity state: ${String(value)}`);
}

export function assertLifecycleEvent(value: unknown): asserts value is EntityLifecycleEvent {
    if (!isEntityLifecycleEvent(value)) throw new TypeError(`unknown entity lifecycle event: ${String(value)}`);
}

/**
 * `deleted` is a reserved terminal alias of `removed`. The transition table
 * does not enter it, so callers that persist the word `deleted` should
 * normalize it to `removed` before asserting a transition. It is never an
 * origin, which keeps a terminal entity from being resurrected through an alias.
 */
export function normalizeLifecycleState(state: EntityState): EntityState {
    return state === "deleted" ? "removed" : state;
}

const transitions = (values: readonly EntityState[]): readonly EntityState[] => Object.freeze([...values]);

const TRANSITION_TABLE: Record<EntityState, readonly EntityState[]> = {
    new: transitions(["managed"]),
    managed: transitions(["detached", "removed"]),
    detached: transitions(["managed", "removed"]),
    removed: transitions([]),
    deleted: transitions([]),
};

/**
 * Legal JPA persistence-context transitions. `deleted` is intentionally listed
 * as a terminal state but is not entered by the table; it is a reserved alias
 * for persisted values, not a distinct persistence-context destination.
 */
export const LIFECYCLE_TRANSITIONS: Readonly<Record<EntityState, readonly EntityState[]>> = Object.freeze(TRANSITION_TABLE);

/**
 * Asserts one persistence-context transition. Throws `TypeError` for unknown
 * states and for edges absent from {@link LIFECYCLE_TRANSITIONS}. `deleted` is
 * deliberately not entered by the table; normalize it with
 * {@link normalizeLifecycleState} first when reading persisted values.
 */
export function assertLifecycleTransition(from: EntityState, to: EntityState): void {
    if (!isEntityState(from) || !isEntityState(to)) {
        throw new TypeError(`unknown lifecycle transition: ${String(from)} -> ${String(to)}`);
    }
    if (!LIFECYCLE_TRANSITIONS[from].includes(to)) {
        throw new TypeError(`invalid lifecycle transition: ${from} -> ${to}`);
    }
}

/** Callback context for one lifecycle event. */
export interface EntityLifecycleContext {
    readonly kind: EntityKind;
    readonly state: EntityState;
    readonly version: number;
    readonly now: string;
}

/** Asserts that a value is a complete {@link EntityLifecycleContext}. */
export function assertEntityLifecycleContext(value: unknown): asserts value is EntityLifecycleContext {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new TypeError("entity lifecycle context must be an object");
    }
    const candidate = value as Partial<EntityLifecycleContext>;
    if (!isEntityKind(candidate.kind)) throw new TypeError(`unknown lifecycle context kind: ${String(candidate.kind)}`);
    assertEntityState(candidate.state, "lifecycle context state");
    if (typeof candidate.version !== "number" || !Number.isSafeInteger(candidate.version) || candidate.version < 0) {
        throw new TypeError("lifecycle context version must be a non-negative safe integer");
    }
    if (typeof candidate.now !== "string" || candidate.now.trim() === "") {
        throw new TypeError("lifecycle context now must be a non-empty string");
    }
}

/** One optional callback per JPA lifecycle event. */
export interface EntityLifecycle<T> {
    readonly prePersist?: (entity: T, context: EntityLifecycleContext) => void;
    readonly postPersist?: (entity: T, context: EntityLifecycleContext) => void;
    readonly preUpdate?: (entity: T, context: EntityLifecycleContext) => void;
    readonly postUpdate?: (entity: T, context: EntityLifecycleContext) => void;
    readonly preRemove?: (entity: T, context: EntityLifecycleContext) => void;
    readonly postRemove?: (entity: T, context: EntityLifecycleContext) => void;
    readonly postLoad?: (entity: T, context: EntityLifecycleContext) => void;
}

/** Frozen result of one dispatcher call. */
export interface LifecycleDispatchResult {
    /** Number of registered callbacks invoked for the event. */
    readonly invoked: number;
    /** Errors thrown by `post*` callbacks, in invocation order. */
    readonly errors: readonly Error[];
}

export interface LifecycleDispatcher<T> {
    /** Appends one callback object; callbacks run in registration order. */
    register(hooks: EntityLifecycle<T>): LifecycleDispatcher<T>;
    fire(event: EntityLifecycleEvent, entity: T, context: EntityLifecycleContext): LifecycleDispatchResult;
}

function normalizeHooks<T>(value: unknown, label: string): EntityLifecycle<T> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new TypeError(`${label} must be an object`);
    }
    const source = value as Readonly<Record<string, unknown>>;
    const normalized: Record<string, (entity: T, context: EntityLifecycleContext) => void> = {};
    for (const event of ENTITY_LIFECYCLE_EVENTS) {
        const callback = source[event];
        if (callback === undefined) continue;
        if (typeof callback !== "function") throw new TypeError(`${label} ${event} must be a function`);
        normalized[event] = callback as (entity: T, context: EntityLifecycleContext) => void;
    }
    return Object.freeze(normalized) as EntityLifecycle<T>;
}

function asLifecycleError(error: unknown): Error {
    if (error instanceof Error) return error;
    return new TypeError(`lifecycle callback threw a non-Error value: ${String(error)}`);
}

function emptyDispatchResult(): LifecycleDispatchResult {
    return Object.freeze({ invoked: 0, errors: Object.freeze([]) as readonly Error[] });
}

/**
 * Creates a dispatcher over zero or more callback objects. A single callback
 * object and an array of them are both accepted; `register` can append more.
 * `pre*` failures abort the call immediately, while `post*` failures are
 * collected so independent cleanup callbacks still run.
 */
export function createLifecycleDispatcher<T = unknown>(
    hooks?: EntityLifecycle<T> | readonly EntityLifecycle<T>[],
): LifecycleDispatcher<T> {
    const registered: EntityLifecycle<T>[] = [];
    const dispatcher: LifecycleDispatcher<T> = {
        register(value: EntityLifecycle<T>): LifecycleDispatcher<T> {
            registered.push(normalizeHooks<T>(value, "lifecycle hooks"));
            return dispatcher;
        },
        fire(event: EntityLifecycleEvent, entity: T, context: EntityLifecycleContext): LifecycleDispatchResult {
            assertLifecycleEvent(event);
            assertEntityLifecycleContext(context);
            let invoked = 0;
            const errors: Error[] = [];
            for (const hook of registered) {
                const callback = hook[event];
                if (callback === undefined) continue;
                invoked += 1;
                try {
                    callback(entity, context);
                } catch (error) {
                    if (event.startsWith("pre")) throw error;
                    errors.push(asLifecycleError(error));
                }
            }
            return Object.freeze({ invoked, errors: Object.freeze(errors) });
        },
    };
    if (hooks !== undefined) {
        const values: readonly EntityLifecycle<T>[] = Array.isArray(hooks)
            ? (hooks as readonly EntityLifecycle<T>[])
            : [hooks as EntityLifecycle<T>];
        for (const hook of values) dispatcher.register(hook);
    }
    return Object.freeze(dispatcher);
}

/**
 * Registry of lifecycle callbacks per `EntityKind`. One callback object may be
 * registered per kind; registering twice is rejected so a kind's callbacks stay
 * predictable. Firing a kind that has no registered callbacks is a no-op.
 */
export class LifecycleRegistry {
    private readonly hooks = new Map<EntityKind, EntityLifecycle<unknown>>();
    private readonly dispatchers = new Map<EntityKind, LifecycleDispatcher<unknown>>();

    constructor(initial?: Readonly<Partial<Record<EntityKind, EntityLifecycle<unknown>>>>) {
        if (initial === undefined) return;
        if (typeof initial !== "object" || initial === null || Array.isArray(initial)) {
            throw new TypeError("lifecycle registry initial hooks must be an object");
        }
        for (const [kind, hooks] of Object.entries(initial)) {
            if (hooks === undefined) continue;
            this.register(kind as EntityKind, hooks);
        }
    }

    register<T>(kind: EntityKind, hooks: EntityLifecycle<T>): this {
        if (!isEntityKind(kind)) throw new TypeError(`unknown entity kind: ${String(kind)}`);
        if (this.hooks.has(kind)) throw new TypeError(`lifecycle hooks are already registered for: ${kind}`);
        const normalized = normalizeHooks<T>(hooks, `lifecycle hooks for ${kind}`);
        this.hooks.set(kind, normalized as unknown as EntityLifecycle<unknown>);
        this.dispatchers.set(kind, createLifecycleDispatcher(normalized) as unknown as LifecycleDispatcher<unknown>);
        return this;
    }

    has(kind: EntityKind): boolean {
        return this.hooks.has(kind);
    }

    get(kind: EntityKind): EntityLifecycle<unknown> | undefined {
        return this.hooks.get(kind);
    }

    /** Registered kinds in registration order. */
    kinds(): readonly EntityKind[] {
        return Object.freeze([...this.hooks.keys()]);
    }

    fire<T = unknown>(
        kind: EntityKind,
        event: EntityLifecycleEvent,
        entity: T,
        context: EntityLifecycleContext,
    ): LifecycleDispatchResult {
        if (!isEntityKind(kind)) throw new TypeError(`unknown entity kind: ${String(kind)}`);
        assertLifecycleEvent(event);
        assertEntityLifecycleContext(context);
        if (context.kind !== kind) {
            throw new TypeError(`lifecycle context kind ${context.kind} does not match ${kind}`);
        }
        const dispatcher = this.dispatchers.get(kind);
        if (dispatcher === undefined) return emptyDispatchResult();
        return dispatcher.fire(event, entity, context);
    }
}
