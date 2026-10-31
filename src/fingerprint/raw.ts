/**
 * Raw, unframed SHA-256 helpers.
 *
 * Every `fingerprint*` function in this module hashes a preimage that starts
 * with a domain header (`amp.fp/1\n<kind>\n<policy>\n<bytes>\n`). That framing is
 * what makes a fingerprint self-describing and injection-resistant, and it is
 * also why a fingerprint digest can never double as a content-address ref: the
 * refs in `ContentStore`, the ledger chain and the audit checkpoints are
 * persisted, shared with other tools and compared as opaque strings, so
 * changing the bytes they hash would invalidate every existing record.
 *
 * These helpers exist so those legacy call sites stop reaching for
 * `node:crypto` directly — one implementation, one strict UTF-8 encoder, one
 * place to change — while keeping their refs byte-identical. They deliberately
 * carry no algorithm, kind or policy: a raw digest proves nothing about how the
 * content should be interpreted, which is exactly the trade-off a CAS makes.
 */
import { bytesToHex, sha256Bytes } from "./algorithm.ts";
import { encodeUtf8Strict } from "./text.ts";

/**
 * Lowercase hex SHA-256 of raw bytes, without an algorithm prefix.
 *
 * The bare form matches the historical `ContentEntry.digest` shape, which is
 * embedded in `digestOf(entries)` and therefore in every module content digest.
 */
export const rawHex: (bytes: Uint8Array) => string = (bytes: Uint8Array): string => bytesToHex(sha256Bytes(bytes));

/**
 * `sha256:<hex>` of raw bytes: the content-address ref form.
 *
 * The prefix is spelled here once, so a store, a verifier and a test cannot
 * disagree about it.
 */
export const rawDigest: (bytes: Uint8Array) => string = (bytes: Uint8Array): string => `sha256:${rawHex(bytes)}`;

/**
 * Lowercase hex SHA-256 of a string's strict UTF-8 bytes.
 *
 * Strict encoding matters: `TextEncoder` maps an unpaired surrogate to U+FFFD,
 * so two different strings would hash identically. A store that silently
 * collapses two keys is a data-loss bug, not a normalisation choice.
 */
export const rawTextHex: (text: string) => string = (text: string): string => rawHex(encodeUtf8Strict(text));

/**
 * `sha256:<hex>` of a string's strict UTF-8 bytes.
 */
export const rawTextDigest: (text: string) => string = (text: string): string => `sha256:${rawTextHex(text)}`;
