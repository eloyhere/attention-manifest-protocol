/** Repository layer: persistence port over one entity descriptor. */

import type { EntityDescriptor, EntityFilter } from "../entity/types.ts";
import type { SqlDriver } from "../sql/types.ts";
import type { EntityCache } from "../cache/types.ts";

export interface Repository<T> {
    get(id: string): T | undefined;
    /** Compare-and-swap on version when expectedVersion is supplied. */
    put(entity: T, options?: { readonly expectedVersion?: number }): T;
    delete(id: string): boolean;
    list(filter?: EntityFilter): readonly T[];
    count(filter?: EntityFilter): number;
}

export interface RepositoryContext {
    readonly driver: SqlDriver;
    readonly cache: EntityCache;
    readonly now: () => string;
    readonly tenantId?: string;
}

export type RepositoryFactory = <T>(descriptor: EntityDescriptor<T>, context: RepositoryContext) => Repository<T>;
