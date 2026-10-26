/**
 * Content-addressed detail store. The ref is a hash of the content, so equal
 * details dedupe and a ref can be verified instead of trusted.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

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
        this.dir = dir;
        mkdirSync(dir, { recursive: true });
    }

    put(content: string): string {
        const hash: string = digest(content);
        const ref: string = `sha256:${hash}`;
        const path: string = `${this.dir}/${hash}.txt`;
        if (!existsSync(path)) {
            writeFileSync(path, content, "utf8");
        }
        return ref;
    }

    get(ref: string): string | undefined {
        if (!ref.startsWith("sha256:")) {
            return undefined;
        }
        const path: string = `${this.dir}/${ref.slice("sha256:".length)}.txt`;
        return existsSync(path) ? readFileSync(path, "utf8") : undefined;
    }
}
