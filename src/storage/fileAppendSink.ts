/**
 * Durable JSONL sink for the append-only logs.
 *
 * This is a host adapter, not part of the domain: it uses the filesystem and
 * therefore lives in `storage`, behind the `AppendSink` port. Each line is one
 * complete JSON object; `readAll` drops blank lines but never rewrites a line.
 *
 * A production host may replace this with a database outbox or a remote log.
 * The sink only promises that `append` returns after the bytes are handed to the
 * OS; call `fsync` at a higher level if the durability requirement is stronger.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

import type { AppendSink } from "./appendLog.ts";

export class FileAppendSink implements AppendSink {
    readonly path: string;

    constructor(path: string) {
        if (typeof(path) !== "string" || path.trim().length === 0) {
            throw new TypeError("FileAppendSink requires a non-empty path");
        }
        this.path = path;
        mkdirSync(dirname(path), { recursive: true });
    }

    append(line: string): void {
        appendFileSync(this.path, `${line}\n`, { encoding: "utf8" });
    }

    readAll(): string[] {
        if (!existsSync(this.path)) {
            return [];
        }
        return readFileSync(this.path, "utf8")
            .split(/\r?\n/)
            .filter((line: string) => line.length > 0);
    }
}
