/** Read-only syntax-tree construction through a session's filesystem sandbox. */
import { readFileSync, statSync } from "node:fs";

import { rawDigest } from "../fingerprint/raw.ts";
import { detectCharset, decodeText } from "../syntax/charset.ts";
import { buildSyntaxTreeFromText, DefaultSyntaxRegistry } from "../syntax/syntaxTree.ts";
import type { SyntaxRegistry, SyntaxTree, SyntaxTreeOptions } from "../syntax/syntaxTree.ts";
import { fail, isFilesystemError } from "./errors.ts";
import type { PathSandbox } from "./path.ts";
import type { RootedPath } from "./types.ts";

const DefaultMaxBytes: number = 4 * 1024 * 1024;

/**
 * Read and parse one file through the session sandbox. The parser is read-only:
 * it never evaluates the file, resolves an import or launches a subprocess.
 */
export const buildSyntaxTree: (sandbox: PathSandbox, path: string, options?: SyntaxTreeOptions) => SyntaxTree = (
    sandbox: PathSandbox,
    path: string,
    options: SyntaxTreeOptions = {},
): SyntaxTree => {
    const rooted: RootedPath = sandbox.resolve(path, "read");
    sandbox.revalidate(rooted);
    const stat = statSync(rooted.absolute);
    if (!stat.isFile()) {
        return fail("not_file");
    }
    const maxBytes: number = Math.min(options.maxBytes ?? DefaultMaxBytes, DefaultMaxBytes);
    if (stat.size > maxBytes) {
        return fail("quota_exceeded");
    }
    const bytes: Uint8Array = readFileSync(rooted.absolute);
    const detected = detectCharset(bytes);
    if (detected.binary) {
        return fail("binary_file");
    }
    let text: string;
    try {
        text = decodeText(bytes, detected.charset);
    } catch (error: unknown) {
        return isFilesystemError(error) ? fail(error.code) : fail("charset_unsupported");
    }
    const registry: SyntaxRegistry = options.registry ?? DefaultSyntaxRegistry;
    const built: SyntaxTree = buildSyntaxTreeFromText(rooted.relative, text, registry.languageOf(rooted.relative), options);
    return { ...built, fingerprint: rawDigest(bytes), charset: detected.charset };
};
