/**
 * Public surface of the fingerprint module.
 *
 * The invariant this barrel protects: every function exported here returns a
 * reference that names the algorithm, the kind and the policy that produced the
 * digest, and every digest is built by `preimage.ts`, so no call site can forget
 * the domain header or the length prefix. A value without its policy is not a
 * fingerprint, it is a hash that happens to match today.
 *
 * The pure core (`algorithm`, `preimage`, `text`, `bytes`, `number`, `json`,
 * `ref`, `verify`) has no `node:` imports and runs unchanged in a browser. Only
 * `file.ts` and `tree.ts` touch `node:fs`, and they are exported from this same
 * barrel because the frozen API requires one entry point; bundling the barrel
 * for a browser therefore pulls them in. Keep that in mind when a browser build
 * needs the pure functions only: import them from their modules, not from here.
 *
 * Non-goals, stated so the module is not asked to do them: a fingerprint is not
 * a signature (it proves sameness, not authorship), it does not replace the
 * canonical bytes used for signing, and similarity sketches (SimHash/MinHash)
 * are explicitly out of scope because their collisions are the point.
 */
export type { AlgorithmId, ByteHasher } from "./algorithm.ts";
export type { Fingerprint, FingerprintKind, FingerprintRef } from "./preimage.ts";
export type { FileFingerprint } from "./file.ts";
export type { TreeEntry, TreeFingerprint } from "./tree.ts";

export { createSha256, sha256Bytes } from "./algorithm.ts";
export { fingerprintBytes } from "./bytes.ts";
export { FingerprintError, FingerprintIOError, FingerprintMismatch, NormalizationRejected, UnsupportedAlgorithm, UnsupportedKind } from "./error.ts";
export { fingerprintFile, fingerprintFileMeta } from "./file.ts";
export { fingerprintJson, fingerprintOf } from "./json.ts";
export { fingerprintBoolean, fingerprintNull, fingerprintNumber } from "./number.ts";
export { Policy } from "./policy.ts";
export { formatRef, formatShort, parseRef, parseShort } from "./ref.ts";
export { rawDigest, rawHex, rawTextDigest, rawTextHex } from "./raw.ts";
export { fingerprintString, fingerprintText } from "./text.ts";
export { fingerprintTree } from "./tree.ts";
export { matches, verify } from "./verify.ts";
