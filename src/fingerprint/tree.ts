/**
 * Canonical directory-tree fingerprints: a Merkle tree over a sorted flat leaf
 * list.
 *
 * Hashing a directory is meaningless until its serialisation is defined —tar
 * and zip are not canonical, which is why Nix hashes NAR rather than raw bytes.
 * The serialisation used here is:
 *
 *     leaf(pathBytes, mode, size, childDigest)
 *         = sha256( 0x00 || u32be(pathBytes.length) || pathBytes
 *                   || u32be(mode) || u64be(size) || childDigest )
 *     node(left, right)
 *         = sha256( 0x01 || left || right )
 *     root
 *         = sha256( 0x02 || u64be(entryCount) || merkleRoot || sha256(utf8(treePolicy)) )
 *
 * The `0x00`/`0x01`/`0x02` prefixes are domain separation in the sense of RFC
 * 6962 §2.1: without them a leaf digest could be replayed as an interior node,
 * which breaks second-preimage resistance. `entryCount` in the root makes `{}`
 * differ from a tree whose only entry is an empty directory even before the
 * leaves are considered, and folding the policy hash into the root binds the
 * exclusion/digest rules to the value.
 *
 * Paths are `/`-separated, relative to the root, and sorted by UTF-8 byte order
 * (`Buffer.compare`), never by locale. `mode` binds the file type and the
 * executable bit; `size` is in the leaf so a verifier compares length before
 * digest, as OCI does. Directories get `sha256(empty)` as their child digest:
 * their content is represented by the leaves of their children, and the leaf's
 * mode field is what keeps the entry from colliding with an empty file at the
 * same path.
 *
 * Symlinks are **never followed**. A symlink is recorded as mode 4 with its
 * target string hashed as the child digest, so a link loop cannot hang the walk
 * and the same tree produces the same root on machines where the link would
 * resolve differently.
 */
import { lstatSync, readdirSync, readlinkSync } from "node:fs";
import type { Stats } from "node:fs";
import { join } from "node:path";

import { bytesToHex, createSha256, hexToBytes } from "./algorithm.ts";
import type { AlgorithmId } from "./algorithm.ts";
import { FingerprintIOError, UnsupportedAlgorithm, describeError } from "./error.ts";
import { fileContentDigest, resolveChunkBytes } from "./file.ts";
import { Policy } from "./policy.ts";
import { SchemeName, shortForm } from "./preimage.ts";
import type { Fingerprint, FingerprintRef } from "./preimage.ts";
import { encodeUtf8Strict } from "./text.ts";

/**
 * One entry of the tree.
 *
 * `digest` is the *child* digest that goes into the leaf record: the file
 * content digest for a regular file, `sha256(utf8(target))` for a symlink, and
 * `sha256(empty)` for a directory. Keeping the child digest (rather than the
 * leaf digest) means a consumer can compare a file against a CAS object while
 * still being able to rebuild the leaf —and therefore the root —from the
 * returned entries.
 */
export interface TreeEntry {
    readonly path: string;
    readonly digest: string;
    readonly size: number;
    readonly mode: number;
}

/**
 * A tree fingerprint plus its root and per-entry detail.
 *
 * `root` is the canonical tree root in bare lowercase hex; `ref.digest` is the
 * same hex and `digest` is its CAS-compatible `<algorithm>:<hex>` spelling.
 * `bytes` in the reference is the total length of the canonical leaf records
 * that were folded, not the sum of the file sizes: it measures the serialised
 * payload the Merkle tree was built from.
 */
export interface TreeFingerprint extends Fingerprint {
    readonly root: string;
    readonly entries: readonly TreeEntry[];
    readonly excluded: readonly string[];
}

/**
 * Option shape for `fingerprintTree`.
 *
 * `exclude` replaces the default exclusion set rather than extending it; there
 * would otherwise be no way to fingerprint a directory that contains a
 * `node_modules` folder on purpose. The applied set is echoed in `excluded` so
 * a verifier can see what was in scope.
 */
export interface TreeFingerprintOptions {
    readonly exclude?: readonly string[];
    readonly algorithm?: AlgorithmId;
    readonly chunkBytes?: number;
}

const ModeFile: number = 1;
const ModeExecutableFile: number = 2;
const ModeDirectory: number = 3;
const ModeSymlink: number = 4;

const LeafPrefix: number = 0x00;
const NodePrefix: number = 0x01;
const RootPrefix: number = 0x02;

const DigestBytes: number = 32;
const LeafFixedBytes: number = 1 + 4 + 4 + 8 + DigestBytes;
const NodeBytes: number = 1 + DigestBytes + DigestBytes;
const RootFixedBytes: number = 1 + 8 + DigestBytes + DigestBytes;
const PathLengthOffset: number = 1;
const ModeOffsetBase: number = 5;
const SizeOffsetBase: number = 9;
const DigestOffsetBase: number = 17;
const NodeLeftOffset: number = 1;
const NodeRightOffset: number = 1 + DigestBytes;
const RootCountOffset: number = 1;
const RootMerkleOffset: number = 9;
const RootPolicyOffset: number = 41;
const Uint32Range: number = 0x100000000;

/**
 * Default exclusions. Version-control metadata, dependency trees, caches and
 * build output are not content: including them would make the same source tree
 * produce different roots on two machines. The set is echoed in `excluded`
 * because "what was ignored" changes the digest and has to be auditable.
 */
const DefaultExclusions: readonly string[] = ["node_modules", ".git", ".cache", "dist", "lib"];

/**
 * Child digest used for directories, and the Merkle root of an empty tree.
 * Both are `sha256(empty)`, which is unambiguous because the leaf records carry
 * path, mode and size, so a directory entry can never be confused with an empty
 * file entry at a different position.
 */
const EmptyDigestHex: string = bytesToHex(createSha256().digest());

/**
 * Compare two relative paths by their UTF-8 bytes.
 *
 * `Array.prototype.sort()` compares UTF-16 code units, which orders astral
 * characters before U+E000–U+FFFF; RFC 8785 and every content-addressed format
 * expect byte order. Decoding through `Buffer` is the cheapest way to get it,
 * and `Buffer.compare` returns the sign `sort` needs.
 */
const comparePaths: (left: string, right: string) => number = (left: string, right: string): number =>
    Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));

/**
 * Validate the exclusion set once.
 *
 * A pattern is a plain entry name, not a glob and not a path: a value containing
 * a separator would silently exclude nothing, and a silent no-op in an exclusion
 * rule is exactly the kind of mistake that later looks like a digest mismatch.
 */
const resolveExclusions: (exclude: readonly string[] | undefined) => readonly string[] = (exclude: readonly string[] | undefined): readonly string[] => {
    const names: readonly string[] = exclude ?? DefaultExclusions;
    const unique: Set<string> = new Set<string>();
    for (let index: number = 0; index < names.length; index += 1) {
        const name: string = names[index];
        if (name.length === 0 || name.includes("/") || name.includes("\\")) {
            throw new TypeError(`exclusion "${name}" must be a single path segment without separators`);
        }
        unique.add(name);
    }
    return [...unique];
};

interface WalkState {
    readonly excluded: ReadonlySet<string>;
    readonly chunkBytes: number;
    readonly entries: TreeEntry[];
}

const lstatOrThrow: (path: string) => Stats = (path: string): Stats => {
    try {
        return lstatSync(path);
    } catch (error: unknown) {
        throw new FingerprintIOError([`cannot stat ${path}: ${describeError(error)}`]);
    }
};

const readDirectoryOrThrow: (path: string) => string[] = (path: string): string[] => {
    try {
        return readdirSync(path);
    } catch (error: unknown) {
        throw new FingerprintIOError([`cannot read directory ${path}: ${describeError(error)}`]);
    }
};

const readLinkOrThrow: (path: string) => string = (path: string): string => {
    try {
        return readlinkSync(path);
    } catch (error: unknown) {
        throw new FingerprintIOError([`cannot read symlink ${path}: ${describeError(error)}`]);
    }
};

/**
 * Depth-first walk that records one entry per filesystem object and never
 * descends through a symlink.
 *
 * Recursion is safe because the walk cannot loop: a symlink is recorded and
 * skipped, so a cycle in the directory graph (which POSIX forbids anyway) is not
 * reachable. Ordering is imposed later by a global sort, so the traversal order
 * here only has to be deterministic, which sorting the child names provides.
 */
const collectEntries: (directory: string, prefix: string, state: WalkState) => void = (directory: string, prefix: string, state: WalkState): void => {
    const names: string[] = readDirectoryOrThrow(directory);
    names.sort(comparePaths);
    for (let index: number = 0; index < names.length; index += 1) {
        const name: string = names[index];
        if (state.excluded.has(name)) {
            continue;
        }
        const fullPath: string = join(directory, name);
        const relativePath: string = prefix.length === 0 ? name : `${prefix}/${name}`;
        const stats: Stats = lstatOrThrow(fullPath);
        if (stats.isSymbolicLink()) {
            const target: string = readLinkOrThrow(fullPath);
            const targetBytes: Uint8Array = encodeUtf8Strict(target);
            state.entries.push({
                path: relativePath,
                digest: bytesToHex(createSha256().update(targetBytes).digest()),
                size: targetBytes.length,
                mode: ModeSymlink,
            });
            continue;
        }
        if (stats.isDirectory()) {
            state.entries.push({ path: relativePath, digest: EmptyDigestHex, size: 0, mode: ModeDirectory });
            collectEntries(fullPath, relativePath, state);
            continue;
        }
        if (!stats.isFile()) {
            throw new FingerprintIOError([`${fullPath} is not a regular file, directory or symlink`]);
        }
        const mode: number = (stats.mode & 0o111) !== 0 ? ModeExecutableFile : ModeFile;
        const digest: string = fileContentDigest(fullPath, stats.size, state.chunkBytes);
        state.entries.push({ path: relativePath, digest, size: stats.size, mode });
    }
};

/**
 * Serialise one entry into its leaf record.
 *
 * `size` is written as a big-endian u64 from its high and low 32-bit halves,
 * which avoids BigInt conversion on the hot path and is exact for every
 * JavaScript number that can be a file size (`Number.isSafeInteger`).
 */
const buildLeafRecord: (entry: TreeEntry) => Uint8Array = (entry: TreeEntry): Uint8Array => {
    const pathBytes: Uint8Array = encodeUtf8Strict(entry.path);
    const record: Uint8Array = new Uint8Array(LeafFixedBytes + pathBytes.length);
    record[0] = LeafPrefix;
    const view: DataView = new DataView(record.buffer);
    view.setUint32(PathLengthOffset, pathBytes.length);
    record.set(pathBytes, PathLengthOffset + 4);
    const modeOffset: number = ModeOffsetBase + pathBytes.length;
    const sizeOffset: number = SizeOffsetBase + pathBytes.length;
    const digestOffset: number = DigestOffsetBase + pathBytes.length;
    view.setUint32(modeOffset, entry.mode);
    view.setUint32(sizeOffset, Math.floor(entry.size / Uint32Range));
    view.setUint32(sizeOffset + 4, entry.size % Uint32Range);
    record.set(hexToBytes(entry.digest), digestOffset);
    return record;
};

/**
 * Fold sorted leaf digests into a Merkle root.
 *
 * Adjacent pairs are combined bottom-up; an odd node is promoted unchanged to
 * the next level, which is the Bitcoin/RFC 6962 style tree and keeps the fold
 * well-defined for any entry count. The empty tree is `sha256(empty)` rather
 * than a special constant, so the one-entry and zero-entry cases differ by an
 * actual hash rather than by convention.
 */
const merkleFold: (leaves: readonly Uint8Array[]) => Uint8Array = (leaves: readonly Uint8Array[]): Uint8Array => {
    if (leaves.length === 0) {
        return createSha256().digest();
    }
    let level: Uint8Array[] = [];
    for (let index: number = 0; index < leaves.length; index += 1) {
        level.push(leaves[index]);
    }
    while (level.length > 1) {
        const next: Uint8Array[] = [];
        for (let index: number = 0; index < level.length; index += 2) {
            if (index + 1 === level.length) {
                next.push(level[index]);
                continue;
            }
            const pair: Uint8Array = new Uint8Array(NodeBytes);
            pair[0] = NodePrefix;
            pair.set(level[index], NodeLeftOffset);
            pair.set(level[index + 1], NodeRightOffset);
            next.push(createSha256().update(pair).digest());
        }
        level = next;
    }
    return level[0];
};

/**
 * Fingerprint a directory tree.
 *
 * The returned entries are sorted by UTF-8 path bytes and carry the child digest
 * each leaf was built from, so a caller can re-derive the root after changing
 * one file without re-reading the whole tree. The algorithm is fixed to SHA-256
 * in this build: the root composition in `amp.fp/1` is defined in terms of
 * SHA-256, so naming another algorithm here would produce a reference whose
 * verifier cannot exist.
 */
export const fingerprintTree: (root: string, options?: TreeFingerprintOptions) => Promise<TreeFingerprint> = async (root: string, options?: TreeFingerprintOptions): Promise<TreeFingerprint> => {
    const algorithm: AlgorithmId = options?.algorithm ?? "sha256";
    if (algorithm !== "sha256") {
        throw new UnsupportedAlgorithm([`tree fingerprints compose with sha256; algorithm "${algorithm}" has no tree backend`]);
    }
    const chunkBytes: number = resolveChunkBytes(options?.chunkBytes);
    const rootStats: Stats = lstatOrThrow(root);
    if (rootStats.isSymbolicLink()) {
        throw new FingerprintIOError([`${root} is a symbolic link; tree fingerprints never follow links`]);
    }
    if (!rootStats.isDirectory()) {
        throw new FingerprintIOError([`${root} is not a directory`]);
    }
    const exclusions: readonly string[] = resolveExclusions(options?.exclude);
    const state: WalkState = { excluded: new Set<string>(exclusions), chunkBytes, entries: [] };
    collectEntries(root, "", state);
    const sorted: TreeEntry[] = state.entries.slice();
    sorted.sort((left: TreeEntry, right: TreeEntry): number => comparePaths(left.path, right.path));

    const leaves: Uint8Array[] = [];
    let totalBytes: number = 0;
    for (let index: number = 0; index < sorted.length; index += 1) {
        const record: Uint8Array = buildLeafRecord(sorted[index]);
        leaves.push(createSha256().update(record).digest());
        totalBytes += record.byteLength;
    }
    const merkleRoot: Uint8Array = merkleFold(leaves);
    const policyDigest: Uint8Array = createSha256().update(encodeUtf8Strict(Policy.treeV1)).digest();
    const rootInput: Uint8Array = new Uint8Array(RootFixedBytes);
    rootInput[0] = RootPrefix;
    const rootView: DataView = new DataView(rootInput.buffer);
    rootView.setUint32(RootCountOffset, Math.floor(sorted.length / Uint32Range));
    rootView.setUint32(RootCountOffset + 4, sorted.length % Uint32Range);
    rootInput.set(merkleRoot, RootMerkleOffset);
    rootInput.set(policyDigest, RootPolicyOffset);
    const rootHex: string = bytesToHex(createSha256().update(rootInput).digest());
    const excluded: readonly string[] = [...exclusions].sort(comparePaths);
    const ref: FingerprintRef = {
        scheme: SchemeName,
        algorithm,
        kind: "tree",
        policy: Policy.treeV1,
        bytes: totalBytes,
        digest: rootHex,
    };
    return { ref, digest: shortForm(algorithm, rootHex), root: rootHex, entries: sorted, excluded };
};
