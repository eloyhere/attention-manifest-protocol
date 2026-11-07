import type { IsolationDirectoryPort } from "./directoryIsolation.ts";

type NodeFs = typeof import("node:fs");
type NodePath = typeof import("node:path");

interface NodeProcessLike {
    readonly getBuiltinModule?: (name: string) => unknown;
}

const processLike = (): NodeProcessLike | undefined =>
    (globalThis as { readonly process?: NodeProcessLike }).process;

const builtin = <T>(name: string): T => {
    const module = processLike()?.getBuiltinModule?.(name);
    if (module === undefined) {
        throw new TypeError(`Node builtin ${name} is unavailable; inject an IsolationDirectoryPort instead of using the default Node directory`);
    }
    return module as T;
};

const nodeFs = (): NodeFs => builtin<NodeFs>("node:fs");
const nodePath = (): NodePath => builtin<NodePath>("node:path");

const errorCode = (error: unknown): string | undefined =>
    typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "string"
        ? (error as { code: string }).code
        : undefined;

export type NodeIsolationDirectoryOptions = {
    /** Permission bits for lock files; default `0o600`. */
    readonly fileMode?: number;
};

/**
 * Real filesystem `IsolationDirectoryPort` for Node. It uses
 * `process.getBuiltinModule("node:fs")` at call time instead of a static
 * `node:fs` import, so the cooperation module stays safe to bundle for hosts
 * that never touch this factory.
 */
export function createNodeIsolationDirectory(root: string, options: NodeIsolationDirectoryOptions = {}): IsolationDirectoryPort {
    if (typeof root !== "string" || root.trim().length === 0) throw new TypeError("Node isolation directory root must be a nonempty string");
    const fileMode = options.fileMode ?? 0o600;
    if (!Number.isSafeInteger(fileMode) || fileMode < 0) throw new TypeError("Node isolation directory fileMode must be a nonnegative integer");
    return {
        writeExclusive(path: string, content: string): boolean {
            try {
                nodeFs().mkdirSync(nodePath().dirname(path), { recursive: true });
                const fd = nodeFs().openSync(path, "wx", fileMode);
                try {
                    nodeFs().writeSync(fd, content);
                } finally {
                    nodeFs().closeSync(fd);
                }
                return true;
            } catch (error) {
                if (errorCode(error) === "EEXIST") return false;
                throw error;
            }
        },
        read(path: string): string | undefined {
            try {
                return nodeFs().readFileSync(path, "utf8");
            } catch (error) {
                if (errorCode(error) === "ENOENT") return undefined;
                throw error;
            }
        },
        remove(path: string): boolean {
            try {
                nodeFs().unlinkSync(path);
                return true;
            } catch (error) {
                if (errorCode(error) === "ENOENT") return false;
                throw error;
            }
        },
        list(directory: string): readonly string[] {
            try {
                return nodeFs().readdirSync(directory, { withFileTypes: true })
                    .filter(entry => entry.isFile())
                    .map(entry => entry.name);
            } catch (error) {
                if (errorCode(error) === "ENOENT") return [];
                throw error;
            }
        },
    };
}

/** True when the current host can build the default Node directory port. */
export const nodeIsolationDirectoryAvailable = (): boolean => {
    try {
        nodeFs();
        nodePath();
        return true;
    } catch {
        return false;
    }
};

/** Resolved root used by `createNodeIsolationDirectory`; exposed for diagnostics. */
export const resolveNodeIsolationRoot = (root: string): string => nodePath().resolve(root);

/** Root path constant, kept explicit so hosts can pre-create/clean the directory. */
export const DEFAULT_NODE_ISOLATION_ROOT = ".cooperation-locks";
