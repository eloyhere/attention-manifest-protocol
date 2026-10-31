/**
 * The frozen policy vocabulary.
 *
 * A digest is only reproducible when the rules that produced its payload are
 * named, so every fingerprint carries one of these exact strings in its
 * preimage header and in its reference. The strings are wire format: renaming
 * one changes every digest it appears in, which is why the table is frozen and
 * the preimage layer refuses any policy that is not listed here. Without that
 * allow-list a crafted policy could contain a newline and inject a second
 * header field, and two different inputs could share a preimage.
 *
 * `file/meta` is the one value that is not a public policy constant: the weak
 * metadata fingerprint has no separate constructor, and putting its policy next
 * to the others keeps the allow-list in a single place instead of duplicating
 * it in the file layer.
 */
export interface PolicyTable {
    readonly bytesRaw: "bytes/raw";
    readonly textNfc: "text/utf8+nfc+lf";
    readonly textRaw: "text/raw";
    readonly stringStrict: "string/utf16-strict";
    readonly numberIeee: "number/ieee754";
    readonly numberInteger: "number/integer";
    readonly booleanLiteral: "boolean/literal";
    readonly nullLiteral: "null/literal";
    readonly jsonJcs: "json/jcs";
    readonly fileBytes: "file/bytes+chunked";
    readonly fileText: "file/text+nfc";
    readonly treeV1: "tree/pathsorted+mode+nosymlink";
}

/**
 * Single source of truth for the policy strings; every other module references
 * these constants rather than repeating a literal.
 */
export const Policy: PolicyTable = {
    bytesRaw: "bytes/raw",
    textNfc: "text/utf8+nfc+lf",
    textRaw: "text/raw",
    stringStrict: "string/utf16-strict",
    numberIeee: "number/ieee754",
    numberInteger: "number/integer",
    booleanLiteral: "boolean/literal",
    nullLiteral: "null/literal",
    jsonJcs: "json/jcs",
    fileBytes: "file/bytes+chunked",
    fileText: "file/text+nfc",
    treeV1: "tree/pathsorted+mode+nosymlink",
};

/**
 * Policy of the weak metadata fingerprint (`size\0mtimeNs`). Exported for the
 * file layer only; it is deliberately absent from `Policy` because no public
 * constructor accepts it as a choice.
 */
type FileMetaPolicyName = "file/meta";
export const FileMetaPolicy: FileMetaPolicyName = "file/meta";

/**
 * Every string `text.ts`, `json.ts`, `file.ts` and `tree.ts` can put into a
 * header. Written as a literal list instead of `Object.values(Policy)` so the
 * set is visible at a glance and survives a future refactor of the table.
 */
const KnownPolicyList: readonly string[] = [
    Policy.bytesRaw,
    Policy.textNfc,
    Policy.textRaw,
    Policy.stringStrict,
    Policy.numberIeee,
    Policy.numberInteger,
    Policy.booleanLiteral,
    Policy.nullLiteral,
    Policy.jsonJcs,
    Policy.fileBytes,
    Policy.fileText,
    Policy.treeV1,
    FileMetaPolicy,
];

/**
 * Membership set used by the parsers and by the preimage builder. A closed set
 * rather than a regex: a regex can be satisfied by a token the verifier later
 * refuses, and then the "policy is named" promise is decorative.
 */
export const KnownPolicies: ReadonlySet<string> = new Set<string>(KnownPolicyList);

/**
 * True when `policy` is one of the strings this module can emit and the
 * verifier can reproduce.
 */
export const isKnownPolicy: (policy: string) => boolean = (policy: string): boolean => KnownPolicies.has(policy);
