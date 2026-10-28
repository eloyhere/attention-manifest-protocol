/**
 * Content-addressed detail store. The ref is a hash of the content, so equal
 * details dedupe and a ref can be verified instead of trusted.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { storedFile } from "./fileStorePath.ts";

export interface ContentStore {
    put(content: string): string;
    get(ref: string): string | undefined;
}

const digest: (content: string) => string = (content: string): string => createHash("sha256").update(content).digest("hex");

export class MemoryContentStore implements ContentStore {
    private readonly contents = new Map<string, string>();

    put(content: string): string {
        const ref: string = `sha256:${digest(content)}`;
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
        const hash: string = digest(content);
        const ref: string = `sha256:${hash}`;
        const path: string = join(this.dir, `${hash}.txt`);
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
        if (!/^sha256:[0-9a-f]{64}$/.test(ref)) {
            return undefined;
        }
        const path: string = join(this.dir, `${ref.slice("sha256:".length)}.txt`);
        if (!existsSync(path) || storedFile(this.dir, path) === (void 0)) {
            return undefined;
        }
        const content: string = readFileSync(path, "utf8");
        if (`sha256:${digest(content)}` !== ref) {
            throw new Error(`content store integrity mismatch: ${ref}`);
        }
        return content;
    }
}
