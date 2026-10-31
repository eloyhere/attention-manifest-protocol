/**
 * Content-addressed detail store. The ref is a hash of the content, so equal
 * details dedupe and a ref can be verified instead of trusted.
 *
 * The ref stays the raw `sha256:<hex>` of the content's strict UTF-8 bytes: a
 * ref is persisted and compared as an opaque string, so it must not acquire a
 * fingerprint's domain header. `rawTextDigest` and `parseShort` from
 * `src/fingerprint` are the single definition of that format, which is why this
 * file no longer spells the prefix or the regex itself.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { parseShort, rawTextDigest } from "../fingerprint/index.ts";
import { storedFile } from "./fileStorePath.ts";

export interface ContentStore {
    put(content: string): string;
    get(ref: string): string | undefined;
}

/**
 * The only ref form this store accepts.
 *
 * Strict on purpose: an unpaired surrogate in the content would otherwise be
 * replaced by U+FFFD and two different documents would share one ref. Rejecting
 * is the fail-closed choice, and `rawTextDigest` is where the strictness lives.
 */
const refOf: (content: string) => string = (content: string): string => rawTextDigest(content);

export class MemoryContentStore implements ContentStore {
    private readonly contents = new Map<string, string>();

    put(content: string): string {
        const ref: string = refOf(content);
        this.contents.set(ref, content);
        return ref;
    }

    get(ref: string): string | undefined {
        return this.contents.get(ref);
    }

    size(): number {
        return this.contents.size;
    }
}

export class FileContentStore implements ContentStore {
    private readonly dir: string;

    constructor(dir: string) {
        mkdirSync(dir, { recursive: true });
        this.dir = realpathSync(dir);
    }

    put(content: string): string {
        const ref: string = refOf(content);
        const path: string = join(this.dir, `${ref.slice("sha256:".length)}.txt`);
        try {
            writeFileSync(path, content, { encoding: "utf8", flag: "wx" });
        } catch (error: unknown) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
                throw error;
            }
        }
        if (this.get(ref) === (void 0)) {
            throw new Error(`invalid content store file: ${ref}`);
        }
        return ref;
    }

    get(ref: string): string | undefined {
        const parsed: ReturnType<typeof parseShort> = parseShort(ref);
        if (parsed === (void 0) || parsed.algorithm !== "sha256") {
            return undefined;
        }
        const path: string = join(this.dir, `${parsed.digest}.txt`);
        if (!existsSync(path) || storedFile(this.dir, path) === (void 0)) {
            return undefined;
        }
        const content: string = readFileSync(path, "utf8");
        if (refOf(content) !== ref) {
            throw new Error(`content store integrity mismatch: ${ref}`);
        }
        return content;
    }
}
