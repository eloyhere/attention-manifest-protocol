/**
 * Cycle-safe serialization utilities.
 *
 * `safeStringify` filters circular and repeated references using
 * `semantic-typescript`'s `useStringify`, `safeParse` reports malformed JSON
 * as `SerializationError`, `traverseSafely` skips already-seen objects while
 * reporting visit/skip counts, and `digestOf` hashes stable JSON text with
 * SHA-256.
 */
export type {
    DigestOf,
    SafeParse,
    SafeStringify,
    SafeStringifyOptions,
    TraversePath,
    TraverseStats,
    TraverseVisitor,
} from "./types.ts";
export { digestOf, safeParse, safeStringify } from "./json.ts";
export { traverseSafely } from "./traverse.ts";
export { SerializationError, isSerializationError } from "semantic-typescript";
