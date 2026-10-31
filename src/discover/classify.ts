/**
 * Internal module classification from a workspace entity's label and source
 * URI. Classification is descriptive: it does not grant access and it never
 * overrides the host's project scope.
 */
import type { WorkspaceEntity } from "../context/workspace.ts";
import type { ModuleKind } from "./kinds.ts";

const FileKindPattern: RegExp = /(^|[._-])(service|tool|controller|route|repository|model|config|test|spec|middleware|component|util)([._-]|$)/;

const kindForToken: (token: string) => ModuleKind | undefined = (token: string): ModuleKind | undefined => {
    if (token === "test" || token === "spec") {
        return "test";
    }
    if (token === "route" || token === "routes" || token === "router" || token === "routers" || token === "api" || token === "apis" || token === "endpoint" || token === "endpoints") {
        return "route";
    }
    if (token === "repository" || token === "repositories" || token === "repo" || token === "repos" || token === "dao" || token === "daos") {
        return "repository";
    }
    if (token === "model" || token === "models" || token === "entity" || token === "entities" || token === "schema" || token === "schemas" || token === "dto" || token === "dtos") {
        return "model";
    }
    if (token === "controller" || token === "controllers" || token === "handler" || token === "handlers") {
        return "controller";
    }
    if (token === "middleware" || token === "middlewares" || token === "guard" || token === "guards" || token === "interceptor" || token === "interceptors") {
        return "middleware";
    }
    if (token === "component" || token === "components" || token === "view" || token === "views" || token === "page" || token === "pages") {
        return "component";
    }
    if (token === "service" || token === "services") {
        return "service";
    }
    if (token === "tool" || token === "tools") {
        return "tool";
    }
    if (token === "config" || token === "configs" || token === "settings" || token === "setting" || token === "env" || token === "conf") {
        return "config";
    }
    if (token === "util" || token === "utils" || token === "helper" || token === "helpers" || token === "lib" || token === "libs" || token === "shared" || token === "common") {
        return "util";
    }
    return undefined;
};

/**
 * Classify one entity. Directories and projects return `unknown`; only files
 * are counted as modules.
 */
export const classifyModule: (entity: WorkspaceEntity) => ModuleKind = (entity: WorkspaceEntity): ModuleKind => {
    if (entity.kind !== "file") {
        return "unknown";
    }
    const label: string = entity.label.toLowerCase();
    const uri: string = entity.source.uri.toLowerCase();
    const filename: string = label.split("/").pop() ?? label;
    const suffix: RegExpMatchArray | null = FileKindPattern.exec(filename);
    if (suffix !== null) {
        const direct: ModuleKind | undefined = kindForToken(suffix[2]);
        if (direct !== undefined) {
            return direct;
        }
    }
    const tokens: string[] = `${uri} ${filename}`.split(/[\\/._\-\s]+/).filter((token: string): boolean => token.length > 0);
    for (let index: number = 0; index < tokens.length; index += 1) {
        const kind: ModuleKind | undefined = kindForToken(tokens[index]);
        if (kind !== undefined) {
            return kind;
        }
    }
    return "unknown";
};

/**
 * Last lowercase extension without the dot; `undefined` for a name with no dot.
 */
export const extensionOf: (uri: string) => string | undefined = (uri: string): string | undefined => {
    const name: string = uri.split("/").pop() ?? uri;
    const dot: number = name.lastIndexOf(".");
    if (dot <= 0 || dot === name.length - 1) {
        return undefined;
    }
    return name.slice(dot + 1).toLowerCase();
};

/**
 * Normalize a caller-supplied extension, accepting `ts` or `.ts`.
 */
export const normalizeExtension: (value: string) => string = (value: string): string => {
    const normalized: string = value.trim().toLowerCase().replace(/^\./, "");
    if (!/^[a-z0-9]{1,16}$/.test(normalized)) {
        throw new RangeError("extension must be 1..16 lowercase letters or digits");
    }
    return normalized;
};
