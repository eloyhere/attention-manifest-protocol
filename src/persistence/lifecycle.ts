/**
 * Lifecycle bridge for the persistence layer.
 *
 * The entity layer owns the hook contract (`EntityLifecycle`,
 * `EntityLifecycleEvent`, `EntityLifecycleContext`) and a pre-populated
 * `ENTITY_LIFECYCLE_REGISTRY`. Persistence fires the hooks around its store
 * operations; hooks receive a detached plain snapshot so a hook can never
 * corrupt a managed proxy or trigger an accidental write-through.
 *
 * `setEntityLifecycleRegistry` is a test seam: pass a registry with custom hooks
 * to observe persistence events, or `undefined` to return to the entity
 * layer's default registry.
 */

import { ENTITY_LIFECYCLE_REGISTRY, LifecycleRegistry } from "../entity/index.ts";
import type { EntityKind, EntityState } from "../entity/types.ts";
import type { EntityLifecycleContext, EntityLifecycleEvent } from "../entity/lifecycle.ts";

let registry: LifecycleRegistry = ENTITY_LIFECYCLE_REGISTRY;

/** The registry currently used by the mappers. */
export function entityLifecycleRegistry(): LifecycleRegistry {
    return registry;
}

/** Installs a registry for subsequent persistence calls. */
export function setEntityLifecycleRegistry(next?: LifecycleRegistry): void {
    registry = next ?? ENTITY_LIFECYCLE_REGISTRY;
}

/** Builds the context required by {@link LifecycleRegistry.fire}. */
export function lifecycleContext(
    kind: EntityKind,
    state: EntityState,
    version: number,
    now: string = new Date().toISOString(),
): EntityLifecycleContext {
    return { kind, state, version, now };
}

/**
 * Fires one hook. `pre*` failures propagate (the write is aborted); `post*`
 * failures are collected by the entity dispatcher and do not undo a durable
 * write, matching JPA's after-the-fact callback semantics.
 */
export function fireEntityLifecycle(
    event: EntityLifecycleEvent,
    kind: EntityKind,
    entity: unknown,
    context: EntityLifecycleContext,
): void {
    registry.fire(kind, event, entity, context);
}
