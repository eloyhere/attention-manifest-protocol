/**
 * Public entity registry. Concrete declarations live in `declarations.ts`; this
 * module only projects them into the frozen `EntityKind -> Entity` lookup that
 * the service and repository layers consume.
 */

import { ENTITY_DECLARATIONS } from "./declarations.ts";
import type { DeclaredEntity } from "./declarations.ts";
import { isEntityKind } from "./key.ts";
import type { EntityDescriptor, EntityKind } from "./types.ts";

export { entityKey } from "./key.ts";
export { jsonDescriptor } from "./entity.ts";

/** Explicit `Record` coverage makes a new `EntityKind` a compile-time obligation. */
export const ENTITY_REGISTRY: Readonly<Record<EntityKind, DeclaredEntity>> = Object.freeze({
    ...ENTITY_DECLARATIONS,
});

export function descriptorFor<T = unknown>(kind: EntityKind): EntityDescriptor<T> {
    if (!isEntityKind(kind)) throw new TypeError(`unknown entity kind: ${String(kind)}`);
    return ENTITY_REGISTRY[kind].descriptor as EntityDescriptor<T>;
}
