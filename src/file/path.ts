/**
 * Root-confined path resolution.
 *
 * Every tool path is a POSIX path relative to one of the session's roots. The
 * sandbox rejects absolute paths, `..`, NUL/control characters and backslashes,
 * then verifies that no existing component is a symlink (unless the host opted
 * into following them). The session root itself is resolved through `realpath`
 * when the session is opened, so replacing a parent directory afterwards cannot
 * move an already-authorized root.
 */
import { lstatSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative as relativePath, resolve as resolvePath, sep } from "node:path";

import type { SessionOperation, SessionRoot } from "../session/types.ts";
import { fail } from "./errors.ts";
import type { RootedPath } from "./types.ts";

/**
 * Sandbox options. Symlink following is off by default because a link is a
 * capability the session was not granted.
 */
export interface PathSandboxOptions {
    readonly followSymlinks?: boolean;
}

const ControlCharacters: RegExp = /[\u0000-\u001f\u007f]/;
const DriveLetter: RegExp = /^[A-Za-z]:/;

/**
 * Normalize one caller-supplied relative path into slash-separated segments.
 * A `.` or empty path means the root itself.
 */
const normalizeRelative: (input: string) => string = (input: string): string => {
    if (typeof(input) !== "string" || ControlCharacters.test(input)) {
        return fail("invalid_path");
    }
    const text: string = input.trim();
    if (text.length === 0 || text === "." || text === "./") {
        return ".";
    }
    if (text.includes("\\")) {
        return fail("invalid_path");
    }
    if (isAbsolute(text) || DriveLetter.test(text) || text.startsWith("//")) {
        return fail("invalid_path");
    }
    const segments: string[] = [];
    const parts: string[] = text.split("/");
    for (let index: number = 0; index < parts.length; index += 1) {
        const part: string = parts[index];
        if (part === "" || part === ".") {
            continue;
        }
        if (part === "..") {
            return fail("path_escape");
        }
        segments.push(part);
    }
    return segments.length === 0 ? "." : segments.join("/");
};

/**
 * Convert a host-relative path to POSIX separators without resolving it.
 */
const toPosix: (value: string) => string = (value: string): string => value.split(sep).join("/");

/**
 * Case-fold only on case-insensitive platforms; the check must not make a
 * POSIX host accept `Readme.md` as `README.md`.
 */
const fold: (value: string) => string = (value: string): string => (process.platform === "win32" ? value.toLowerCase() : value);

export class PathSandbox {
    private readonly roots: readonly SessionRoot[];
    private readonly byId: Map<string, SessionRoot> = new Map<string, SessionRoot>();
    private readonly followSymlinks: boolean;
    private readonly defaultRootId: string;

    constructor(roots: readonly SessionRoot[], options: PathSandboxOptions = {}) {
        if (!Array.isArray(roots) || roots.length === 0) {
            throw new Error("path sandbox requires at least one root");
        }
        const seenIds: Set<string> = new Set<string>();
        const seenPaths: Set<string> = new Set<string>();
        const normalized: SessionRoot[] = [];
        for (let index: number = 0; index < roots.length; index += 1) {
            const root: SessionRoot = roots[index];
            if (
                root === null ||
                typeof(root) !== "object" ||
                typeof(root.id) !== "string" ||
                root.id.trim().length === 0 ||
                typeof(root.path) !== "string" ||
                !isAbsolute(root.path) ||
                typeof(root.writable) !== "boolean" ||
                !Array.isArray(root.exclude) ||
                root.exclude.some((entry: unknown): boolean => typeof(entry) !== "string") ||
                seenIds.has(root.id)
            ) {
                throw new Error("invalid or duplicate session root");
            }
            let real: string;
            try {
                if (!statSync(root.path).isDirectory()) {
                    throw new Error("root is not a directory");
                }
                real = realpathSync(root.path);
            } catch {
                throw new Error("invalid or inaccessible session root");
            }
            const identity: string = fold(real);
            if (seenPaths.has(identity)) {
                throw new Error("invalid or duplicate session root");
            }
            seenIds.add(root.id);
            seenPaths.add(identity);
            normalized.push({ id: root.id, path: real, writable: root.writable, exclude: [...root.exclude] });
        }
        this.roots = normalized;
        for (const root of normalized) {
            this.byId.set(root.id, root);
        }
        this.followSymlinks = options.followSymlinks === true;
        this.defaultRootId = normalized[0].id;
    }

    /**
     * All roots, in the order the session declared them.
     */
    listRoots(): readonly SessionRoot[] {
        return this.roots.map((root: SessionRoot): SessionRoot => ({ ...root, exclude: [...root.exclude] }));
    }

    /**
     * The root used when a path does not name one explicitly.
     */
    defaultRoot(): SessionRoot {
        return this.root(this.defaultRootId);
    }

    /**
     * Look up a root by id.
     */
    root(id: string): SessionRoot {
        const root: SessionRoot | undefined = this.byId.get(id);
        return root === (void 0) ? fail("invalid_path") : { ...root, exclude: [...root.exclude] };
    }

    /**
     * Resolve a caller path to a root, a normalized relative path and an
     * absolute host path. The method does not require the target to exist; a
     * write may create it. Symlink checks stop at the first missing component.
     *
     * @param input - Root-relative POSIX path, optionally prefixed by `rootId/`.
     * @param operation - Operation used for writability checks.
     * @returns Resolved path.
     */
    resolve(input: unknown, operation: SessionOperation): RootedPath {
        if (typeof(input) !== "string") {
            return fail("invalid_path");
        }
        const normalized: string = normalizeRelative(input);
        let root: SessionRoot = this.defaultRoot();
        let relative: string = normalized;
        const firstSlash: number = normalized.indexOf("/");
        const firstSegment: string = firstSlash === -1 ? normalized : normalized.slice(0, firstSlash);
        const named: SessionRoot | undefined = this.byId.get(firstSegment);
        if (named !== (void 0)) {
            root = named;
            relative = firstSlash === -1 ? "." : normalized.slice(firstSlash + 1);
        }
        if (this.isExcluded(root, relative)) {
            return fail("excluded_path");
        }
        if ((operation === "write" || operation === "create" || operation === "remove") && !root.writable) {
            return fail("permission_denied");
        }
        const absolute: string = resolvePath(join(root.path, relative));
        if (!this.contains(root.path, absolute)) {
            return fail("path_escape");
        }
        this.assertNoSymlinkEscape(root, relative, absolute);
        return { root: { ...root, exclude: [...root.exclude] }, relative, absolute };
    }

    /**
     * Whether an absolute path is inside a root, using the platform's case
     * sensitivity.
     */
    contains(rootPath: string, absolute: string): boolean {
        const path: string = relativePath(rootPath, absolute);
        if (path === "") {
            return true;
        }
        if (isAbsolute(path)) {
            return false;
        }
        return path !== ".." && !path.startsWith(`..${sep}`) && !path.startsWith("../");
    }

    /**
     * Prefix/name exclusion. A bare name excludes a segment at any depth; a
     * value containing `/` is a root-relative prefix.
     */
    isExcluded(root: SessionRoot, relative: string): boolean {
        const target: string = relative === "." ? "" : relative;
        return root.exclude.some((entry: string): boolean => {
            const value: string = entry.replace(/^\.?\//, "").replace(/\/+$/, "");
            if (value.length === 0) {
                return false;
            }
            if (value.includes("/")) {
                return target === value || target.startsWith(`${value}/`);
            }
            return target.split("/").includes(value);
        });
    }

    /**
     * The root-relative POSIX path for an absolute path already known to be in
     * the root.
     */
    relative(root: SessionRoot, absolute: string): string {
        return toPosix(relativePath(root.path, absolute)) || ".";
    }

    /**
     * Re-check that a path still resolves inside its root. Used after a write
     * rename and before a read, so a component swapped for a symlink between
     * resolution and I/O is rejected.
     */
    revalidate(rooted: RootedPath): void {
        const root: SessionRoot = this.byId.get(rooted.root.id) ?? fail("invalid_path");
        if (root.path !== rooted.root.path || rooted.absolute !== resolvePath(join(root.path, rooted.relative)) || !this.contains(root.path, rooted.absolute)) {
            return fail("path_escape");
        }
        this.assertNoSymlinkEscape(root, rooted.relative, rooted.absolute);
    }

    private assertNoSymlinkEscape(root: SessionRoot, relative: string, absolute: string): void {
        try {
            if (realpathSync(root.path) !== root.path) {
                return fail("path_escape");
            }
        } catch {
            return fail("invalid_path");
        }
        if (relative === ".") {
            return;
        }
        const segments: string[] = relative.split("/");
        let current: string = root.path;
        for (let index: number = 0; index < segments.length; index += 1) {
            current = join(current, segments[index]);
            let stat: ReturnType<typeof lstatSync>;
            try {
                stat = lstatSync(current);
            } catch {
                return;
            }
            if (stat.isSymbolicLink()) {
                if (!this.followSymlinks) {
                    return fail("symlink_denied");
                }
                const real: string = realpathSync(current);
                if (!this.contains(root.path, real)) {
                    return fail("path_escape");
                }
                current = real;
            }
        }
        if (this.followSymlinks) {
            try {
                const real: string = realpathSync(absolute);
                if (!this.contains(root.path, real)) {
                    return fail("path_escape");
                }
            } catch {
                return;
            }
        }
    }
}
