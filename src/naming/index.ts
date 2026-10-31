/**
 * Public naming surface: frozen ids, grammar, compatibility aliases and the
 * catalog summary.
 *
 * Consumers import from this barrel so the dependency direction stays
 * `naming -> semantic`. No file under `src/naming` may reach a runtime,
 * database, governance or filesystem module, which keeps naming usable in a
 * browser bundle and free of I/O.
 */

export * from "./aliases.ts";
export * from "./catalog.ts";
export * from "./grammar.ts";
export * from "./ids.ts";
