/**
 * Project manifest hook.
 *
 * A project model answers the three questions an agent has before reading a
 * build file: which ecosystem is this, what is it called and what does it
 * declare. The ecosystem is a pure function of the file name. The name and
 * version are extracted with the smallest possible parser: `JSON.parse` for
 * `package.json` and a line regex for TOML manifests. A failed or missing
 * manifest simply leaves those two fields out; it never fails the model,
 * because the outline and the dependency report are still useful.
 *
 * `manifestOutline` comes from `session.outline` and `dependencies` from
 * `session.dependency` with the manifest path as the root. Both are read-only;
 * the hook layer never runs a package manager, a build tool or a resolver.
 */
import type { DependencyReport, ReadPage } from "../file/types.ts";
import type { OutlineResult } from "../outline/types.ts";
import type { Hook, HookOptions, HookSession } from "./types.ts";
import { createHook } from "./types.ts";

/**
 * Build ecosystem recognized by the project hook.
 */
export type ProjectKind = "npm" | "maven" | "gradle" | "cmake" | "cargo" | "go" | "python" | "make" | "unknown";

/**
 * Model of one project manifest.
 */
export interface ProjectModel {
    readonly path: string;
    readonly kind: ProjectKind;
    readonly name?: string;
    readonly version?: string;
    readonly manifestOutline: OutlineResult;
    readonly dependencies: DependencyReport;
}

/**
 * Request accepted by `useProject`.
 */
export interface ProjectRequest {
    readonly path: string;
}

/**
 * Parse helper shape: one manifest path in, one project model out.
 */
export type ProjectParse = (path: string) => ProjectModel;

/**
 * Leading lines read for name/version extraction. Manifests put their identity
 * near the top; a larger read would only add latency to a model that does not
 * otherwise need the text.
 */
const ManifestLines: number = 400;

/**
 * Byte budget for the same read.
 */
const ManifestBytes: number = 256 * 1024;

/**
 * Manifest file name to ecosystem. The map is exact-case; `makefile` and
 * `GNUmakefile` are included because GNU make accepts them as canonical names.
 */
const ProjectKinds: ReadonlyMap<string, ProjectKind> = new Map<string, ProjectKind>([
    ["package.json", "npm"],
    ["pom.xml", "maven"],
    ["build.gradle", "gradle"],
    ["build.gradle.kts", "gradle"],
    ["CMakeLists.txt", "cmake"],
    ["Cargo.toml", "cargo"],
    ["go.mod", "go"],
    ["pyproject.toml", "python"],
    ["Makefile", "make"],
    ["makefile", "make"],
    ["GNUmakefile", "make"],
]);

/**
 * TOML sections that are allowed to declare the package identity. Dependency
 * tables also contain `name` keys (for example a Cargo dependency alias), so a
 * section check is what keeps a dependency from renaming the project.
 */
const IdentitySections: ReadonlySet<string> = new Set<string>(["package", "project", "tool.poetry", "tool.pdm", "tool.flit.metadata"]);

/**
 * TOML table header, single or array form.
 */
const TomlSection: RegExp = /^\s*\[\[?([^\]]+)\]\]?\s*(?:#.*)?$/;

/**
 * TOML `name`/`version` assignment with a basic or literal string value.
 */
const TomlField: RegExp = /^\s*(name|version)\s*=\s*(?:"([^"]*)"|'([^']*)')\s*(?:#.*)?$/;

/**
 * Identity fields a manifest may declare.
 */
interface ProjectIdentity {
    readonly name?: string;
    readonly version?: string;
}

/**
 * Leaf name of a root-relative path.
 *
 * @param path - POSIX path.
 * @returns Last segment.
 */
const baseNameOf: (path: string) => string = (path: string): string => {
    const slash: number = path.lastIndexOf("/");
    return slash === -1 ? path : path.slice(slash + 1);
};

/**
 * Recognize a project manifest by file name.
 *
 * @param path - Root-relative path.
 * @returns Ecosystem tag, or `unknown`.
 */
export const projectKindOf: (path: string) => ProjectKind = (path: string): ProjectKind => ProjectKinds.get(baseNameOf(path)) ?? "unknown";

/**
 * Extract `name`/`version` from a JSON manifest. A malformed document or a
 * non-string field is ignored rather than reported.
 *
 * @param text - Whole manifest text.
 * @returns Identity fields that were present as non-empty strings.
 */
const jsonIdentity: (text: string) => ProjectIdentity = (text: string): ProjectIdentity => {
    try {
        const value: unknown = JSON.parse(text);
        if (value === null || typeof(value) !== "object" || Array.isArray(value)) {
            return {};
        }
        const record: Record<string, unknown> = value as Record<string, unknown>;
        const name: unknown = record.name;
        const version: unknown = record.version;
        return {
            ...(typeof(name) === "string" && name.length > 0 ? { name } : {}),
            ...(typeof(version) === "string" && version.length > 0 ? { version } : {}),
        };
    } catch {
        return {};
    }
};

/**
 * Extract `name`/`version` from a TOML manifest with a section-aware line
 * scanner. This stays a deliberate simplification (no multi-line strings or
 * dotted keys), but it accepts both TOML string forms and only reads the
 * `[package]`/`[project]`/poetry tables, so a dependency named `name` cannot
 * shadow the project identity.
 *
 * @param text - Whole manifest text.
 * @returns Identity fields that were present.
 */
const tomlIdentity: (text: string) => ProjectIdentity = (text: string): ProjectIdentity => {
    let section: string = "";
    let name: string | undefined;
    let version: string | undefined;
    const lines: string[] = text.split("\n");
    for (let index: number = 0; index < lines.length; index += 1) {
        const line: string = lines[index];
        const sectionMatch: RegExpExecArray | null = TomlSection.exec(line);
        if (sectionMatch !== null) {
            section = sectionMatch[1].trim();
            continue;
        }
        if (!IdentitySections.has(section)) {
            continue;
        }
        const fieldMatch: RegExpExecArray | null = TomlField.exec(line);
        if (fieldMatch === null) {
            continue;
        }
        const value: string = fieldMatch[2] !== (void 0) ? fieldMatch[2] : fieldMatch[3];
        if (value.length === 0) {
            continue;
        }
        if (fieldMatch[1] === "name" && name === (void 0)) {
            name = value;
        } else if (fieldMatch[1] === "version" && version === (void 0)) {
            version = value;
        }
        if (name !== (void 0) && version !== (void 0)) {
            break;
        }
    }
    return {
        ...(name === (void 0) ? {} : { name }),
        ...(version === (void 0) ? {} : { version }),
    };
};

/**
 * Choose the identity extractor by ecosystem.
 *
 * @param kind - Recognized ecosystem.
 * @param text - Manifest text, or `""` when it could not be read.
 * @returns Identity fields.
 */
const identityOf: (kind: ProjectKind, text: string) => ProjectIdentity = (kind: ProjectKind, text: string): ProjectIdentity => {
    if (text.length === 0) {
        return {};
    }
    switch (kind) {
        case "npm": {
            return jsonIdentity(text);
        }
        case "cargo":
        case "python": {
            return tomlIdentity(text);
        }
        default: {
            return {};
        }
    }
};

/**
 * Read the declaration text of a manifest, returning `""` on any failure. The
 * outline call that follows still surfaces a missing or unreadable file, so
 * this swallow only affects the optional name/version fields.
 *
 * @param session - Bound filesystem session.
 * @param path - Root-relative manifest path.
 * @returns Decoded text or `""`.
 */
const readManifest: (session: HookSession, path: string) => string = (session: HookSession, path: string): string => {
    try {
        const page: ReadPage = session.read({ path, maxLines: ManifestLines, maxBytes: ManifestBytes });
        return page.text;
    } catch {
        return "";
    }
};

/**
 * Assemble one project model.
 *
 * @param session - Bound filesystem session.
 * @param path - Root-relative manifest path.
 * @returns Project model.
 */
const projectModelOf: (session: HookSession, path: string) => ProjectModel = (session: HookSession, path: string): ProjectModel => {
    const kind: ProjectKind = projectKindOf(path);
    const text: string = kind === "unknown" ? "" : readManifest(session, path);
    const identity: ProjectIdentity = identityOf(kind, text);
    const manifestOutline: OutlineResult = session.outline({ path });
    const dependencies: DependencyReport = session.dependency({ mode: "dependencies", roots: [path] });
    return {
        path,
        kind,
        ...(identity.name === (void 0) ? {} : { name: identity.name }),
        ...(identity.version === (void 0) ? {} : { version: identity.version }),
        manifestOutline,
        dependencies,
    };
};

/**
 * Read the project model for one manifest path.
 *
 * @param session - Bound filesystem session.
 * @returns Parse helper.
 */
export const useParse: (session: HookSession) => ProjectParse =
    (session: HookSession): ProjectParse =>
    (path: string): ProjectModel =>
        projectModelOf(session, path);

/**
 * Project hook.
 *
 * @param session - Bound filesystem session.
 * @param options - Recorder and cache options.
 * @returns Hook producing one project model.
 */
export const useProject: (session: HookSession, options?: HookOptions) => Hook<ProjectRequest, ProjectModel> = (session: HookSession, options: HookOptions = {}): Hook<ProjectRequest, ProjectModel> =>
    createHook<ProjectRequest, ProjectModel>({
        name: "project",
        session,
        execute: (request: ProjectRequest): ProjectModel => projectModelOf(session, request.path),
        pathOf: (request: ProjectRequest): string => request.path,
        options,
    });
