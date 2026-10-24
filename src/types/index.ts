/**
 * AMP v0.1 — public type surface.
 *
 * These types mirror docs/schemas/*.schema.json one-to-one.
 * They are contracts, not an implementation: the runtime that enforces the
 * 12 invariants lives outside this package.
 */
export type * from './common.ts'
export type * from './manifest.ts'
export type * from './frame.ts'
export type * from './epistemic.ts'
export type * from './concept.ts'
export type * from './plan.ts'
export type * from './social.ts'
export type * from './receipt.ts'
export type * from './protocol.ts'
export type * from './federation.ts'
export type * from './collaboration.ts'
export type * from './team.ts'
