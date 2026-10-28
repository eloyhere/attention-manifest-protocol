/**
 * Offline TypeScript/JavaScript + package.json + Markdown adapter. Inputs are
 * explicit file contents; no execution, network, filesystem crawl or plugins.
 * Compiler resolution is restricted to these inputs, not installed packages.
 */
import { createHash } from "node:crypto";
import { posix } from "node:path";
import ts from "typescript";

import type { ContentStore } from "../../src/context/contentStore.ts";
import type { WorkspaceDiagnostic, WorkspaceEntity, WorkspaceRelation, WorkspaceSnapshot, WorkspaceSource } from "../../src/context/workspace.ts";
import { workspaceTerms } from "../../src/context/workspace.ts";

export interface WorkspaceFile {
    path: string;
    content: string;
}

type WorkspaceScanner = (inputs: readonly WorkspaceFile[], store: ContentStore) => WorkspaceSnapshot;
type SourceLocator = (path: string, startLine?: number, endLine?: number) => WorkspaceSource;
type ExternalLocator = (project: ProjectInput, name: string, origin: WorkspaceSource, description: string) => string;

interface ProjectInput {
    id: string;
    root: string;
    name: string;
    manifest: Record<string, unknown>;
    source: WorkspaceSource;
}

interface HeadingEntry {
    id: string;
    level: number;
}

const hash: (text: string) => string = (text: string): string => createHash("sha256").update(text).digest("hex");
const parseText: (text: string) => string = (text: string): string => text.replace(/^\uFEFF/, "");
const short: (text: string) => string = (text: string): string => text.replace(/\s+/g, " ").trim().slice(0, 180);
const script: (path: string) => boolean = (path: string): boolean => /\.(?:[cm]?[jt]sx?)$/.test(path);

export const scanWorkspace: WorkspaceScanner = (inputs: readonly WorkspaceFile[], store: ContentStore): WorkspaceSnapshot => {
    const files: Map<string, string> = new Map();
    inputs.forEach((file: WorkspaceFile): void => {
        const path: string = file.path.replace(/\\/g, "/");
        if (
            !path ||
            path.startsWith("/") ||
            /^[a-z]:/i.test(path) ||
            posix.normalize(path) !== path ||
            path === ".." ||
            path.startsWith("../") ||
            files.has(path)
        ) {
            throw new Error(`invalid or duplicate workspace path ${path}`);
        }
        files.set(path, file.content);
    });
    const paths: string[] = [...files.keys()].sort();
    const revision: string = hash(JSON.stringify(paths.map((path: string): string[] => [path, hash(files.get(path)!)])));
    const entities: Map<string, WorkspaceEntity> = new Map();
    const relations: WorkspaceRelation[] = [];
    const diagnostics: WorkspaceDiagnostic[] = [];
    const source: SourceLocator = (path: string, startLine?: number, endLine?: number): WorkspaceSource => ({
        uri: path,
        revision: hash(files.get(path) ?? ""),
        ...(startLine === (void 0) ? {} : { startLine }),
        ...(endLine === (void 0) ? {} : { endLine }),
    });
    const projects: ProjectInput[] = [];
    paths
        .filter((path: string): boolean => posix.basename(path) === "package.json")
        .forEach((path: string): void => {
            let manifest: Record<string, unknown>;
            try {
                const parsed: unknown = JSON.parse(parseText(files.get(path)!));
                if (!parsed || typeof(parsed) !== "object" || Array.isArray(parsed)) {
                    throw new Error("manifest must be an object");
                }
                manifest = parsed as Record<string, unknown>;
            } catch {
                diagnostics.push({ uri: path, code: "invalid_manifest", message: "package.json could not be parsed as an object" });
                return;
            }
            const root: string = posix.dirname(path) === "." ? "" : posix.dirname(path);
            projects.push({
                id: `project:${root || "."}`,
                root,
                name: typeof(manifest.name) === "string" ? manifest.name : root || "workspace",
                manifest,
                source: source(path),
            });
        });
    if (!projects.some((project: ProjectInput): boolean => project.root === "")) {
        projects.push({ id: "project:.", root: "", name: "workspace", manifest: {}, source: { uri: ".", revision } });
    }
    projects.sort((left: ProjectInput, right: ProjectInput): number => right.root.length - left.root.length || left.id.localeCompare(right.id));
    projects.forEach((project: ProjectInput): void => {
        entities.set(project.id, {
            id: project.id,
            kind: "project",
            projectId: project.id,
            label: project.name,
            summary: `${project.name} project at ${project.root || "."}`,
            source: project.source,
        });
    });
    const owner: (path: string) => ProjectInput = (path: string): ProjectInput =>
        projects.find((project: ProjectInput): boolean => !project.root || path.startsWith(`${project.root}/`))!;
    paths.forEach((path: string): void => {
        const project: ProjectInput = owner(path);
        const relative: string = project.root ? path.slice(project.root.length + 1) : path;
        const parts: string[] = relative.split("/");
        let parentId: string = project.id;
        let directory: string = project.root;
        parts.slice(0, -1).forEach((part: string): void => {
            directory = directory ? `${directory}/${part}` : part;
            const id: string = `directory:${directory}`;
            if (!entities.has(id)) {
                entities.set(id, {
                    id,
                    kind: "directory",
                    parentId,
                    projectId: project.id,
                    label: part,
                    summary: `directory ${directory}`,
                    source: { uri: directory, revision },
                });
            }
            parentId = id;
        });
        entities.set(`file:${path}`, {
            id: `file:${path}`,
            kind: "file",
            parentId,
            projectId: project.id,
            label: path,
            summary: `file ${path}`,
            source: source(path),
            detailRef: store.put(files.get(path)!),
        });
    });
    const packages: Map<string, string> = new Map();
    const external: ExternalLocator = (project: ProjectInput, name: string, origin: WorkspaceSource, description: string): string => {
        const key: string = JSON.stringify([project.id, name]);
        const existing: string | undefined = packages.get(key);
        if (existing !== (void 0)) {
            return existing;
        }
        const id: string = `package:${key}`;
        entities.set(id, { id, kind: "package", projectId: project.id, parentId: project.id, label: name, summary: `${name}: ${description}`, source: origin });
        packages.set(key, id);
        return id;
    };
    projects.forEach((project: ProjectInput): void => {
        ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"].forEach((section: string): void => {
            const values: unknown = project.manifest[section];
            if (!values || typeof(values) !== "object" || Array.isArray(values)) {
                return;
            }
            Object.entries(values)
                .sort(([left]: [string, unknown], [right]: [string, unknown]): number => left.localeCompare(right))
                .forEach(([name, range]: [string, unknown]): void => {
                    if (typeof(range) !== "string") {
                        diagnostics.push({ uri: project.source.uri, code: "invalid_dependency", message: `non-string declaration for ${name}` });
                        return;
                    }
                    const matches: ProjectInput[] = projects.filter((candidate: ProjectInput): boolean => candidate.name === name);
                    const localRoot: string | undefined = /^(?:file|link):/.test(range)
                        ? posix.normalize(posix.join(project.root, range.slice(range.indexOf(":") + 1))).replace(/^\.$/, "")
                        : (void 0);
                    const local: ProjectInput | undefined =
                        range.startsWith("workspace:") && matches.length === 1
                            ? matches[0]
                            : localRoot === (void 0)
                              ? (void 0)
                              : projects.find((candidate: ProjectInput): boolean => candidate.root === localRoot);
                    const target: string = local?.id ?? external(project, name, project.source, `declared ${range}; installed version not inspected`);
                    if ((range.startsWith("workspace:") || localRoot !== (void 0)) && !local) {
                        diagnostics.push({ uri: project.source.uri, code: "unresolved_project", message: `${name}: ${range}` });
                    }
                    if (matches.length > 1) {
                        diagnostics.push({ uri: project.source.uri, code: "ambiguous_project", message: `multiple projects named ${name}` });
                    }
                    packages.set(JSON.stringify([project.id, name]), target);
                    relations.push({ from: project.id, to: target, kind: "project_depends_on", source: project.source, method: "manifest" });
                });
        });
    });

    const virtualRoot: string = "/workspace/";
    const virtualPath: (name: string) => string = (name: string): string => name.replace(/\\/g, "/");
    const read: (name: string) => string | undefined = (name: string): string | undefined => {
        const text: string | undefined = virtualPath(name).startsWith(virtualRoot) ? files.get(virtualPath(name).slice(virtualRoot.length)) : (void 0);
        return text === (void 0) ? (void 0) : parseText(text);
    };
    const directories: Set<string> = new Set(["/workspace"]);
    paths.forEach((path: string): void => {
        let directory: string = posix.dirname(`${virtualRoot}${path}`);
        while (directory.startsWith("/workspace") && !directories.has(directory)) {
            directories.add(directory);
            directory = posix.dirname(directory);
        }
    });
    const configHost: ts.ParseConfigHost = {
        useCaseSensitiveFileNames: true,
        fileExists: (name: string): boolean => read(name) !== (void 0),
        readFile: read,
        readDirectory: (root: string): string[] =>
            paths
                .map((path: string): string => `${virtualRoot}${path}`)
                .filter((path: string): boolean => path.startsWith(`${virtualPath(root).replace(/\/$/, "")}/`)),
    };
    let compilerOptions: ts.CompilerOptions = {
        target: ts.ScriptTarget.ESNext,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        jsx: ts.JsxEmit.Preserve,
    };
    if (files.has("tsconfig.json")) {
        const config: ts.ParsedCommandLine = ts.getParsedCommandLineOfConfigFile(
            `${virtualRoot}tsconfig.json`,
            {},
            {
                ...configHost,
                getCurrentDirectory: (): string => "/workspace",
                onUnRecoverableConfigFileDiagnostic: (item: ts.Diagnostic): void => {
                    diagnostics.push({ uri: "tsconfig.json", code: "config_error", message: ts.flattenDiagnosticMessageText(item.messageText, " ") });
                },
            },
        );
        if (config) {
            compilerOptions = { ...compilerOptions, ...config.options };
            config.errors.forEach((item: ts.Diagnostic): void => {
                diagnostics.push({ uri: "tsconfig.json", code: "config_error", message: ts.flattenDiagnosticMessageText(item.messageText, " ") });
            });
        }
    }
    compilerOptions = { ...compilerOptions, allowJs: true, noLib: true, noEmit: true, types: [] };
    const host: ts.CompilerHost = {
        ...ts.createCompilerHost(compilerOptions),
        fileExists: configHost.fileExists,
        readFile: read,
        directoryExists: (path: string): boolean => directories.has(virtualPath(path).replace(/\/$/, "")),
        getDirectories: (path: string): string[] => {
            const root: string = virtualPath(path).replace(/\/$/, "");
            return [...directories].filter((directory: string): boolean => posix.dirname(directory) === root && directory !== root);
        },
        getCurrentDirectory: (): string => "/workspace",
        getCanonicalFileName: virtualPath,
        realpath: virtualPath,
        getSourceFile: (name: string, languageVersion: ts.ScriptTarget): ts.SourceFile | undefined => {
            const text: string | undefined = read(name);
            return text === (void 0) ? (void 0) : ts.createSourceFile(virtualPath(name), text, languageVersion, true);
        },
    };
    const program: ts.Program = ts.createProgram(
        paths.filter(script).map((path: string): string => `${virtualRoot}${path}`),
        compilerOptions,
        host,
    );
    const checker: ts.TypeChecker = program.getTypeChecker();
    const declarations: Map<ts.Node, string> = new Map();
    const scripts: ts.SourceFile[] = program.getSourceFiles().filter((file: ts.SourceFile): boolean => files.has(file.fileName.slice(virtualRoot.length)));
    scripts.forEach((file: ts.SourceFile): void => {
        const path: string = file.fileName.slice(virtualRoot.length);
        program.getSyntacticDiagnostics(file).forEach((item: ts.Diagnostic): void => {
            diagnostics.push({ uri: path, code: "syntax_error", message: ts.flattenDiagnosticMessageText(item.messageText, " ") });
        });
        const visit: (node: ts.Node, parentId: string) => void = (node: ts.Node, parentId: string): void => {
            let nextParent: string = parentId;
            const named: boolean =
                ts.isFunctionDeclaration(node) ||
                ts.isClassDeclaration(node) ||
                ts.isInterfaceDeclaration(node) ||
                ts.isTypeAliasDeclaration(node) ||
                ts.isEnumDeclaration(node) ||
                ts.isMethodDeclaration(node) ||
                (ts.isVariableDeclaration(node) && ts.isSourceFile(node.parent.parent.parent));
            const name: ts.Node | undefined = named ? (node as ts.NamedDeclaration).name : (void 0);
            if (name !== (void 0)) {
                const label: string = name.getText(file);
                const id: string = `symbol:${path}#${label}@${node.getStart(file)}`;
                const startLine: number = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
                const endLine: number = file.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
                const text: string = node.getText(file);
                const body: ts.Node | undefined = (node as ts.FunctionLikeDeclaration).body;
                const signature: string = body ? file.text.slice(node.getStart(file), body.getStart(file)) : text;
                entities.set(id, {
                    id,
                    kind: "symbol",
                    projectId: owner(path).id,
                    parentId,
                    label,
                    summary: short(signature),
                    source: source(path, startLine, endLine),
                    detailRef: store.put(text),
                });
                declarations.set(node, id);
                nextParent = id;
            }
            ts.forEachChild(node, (child: ts.Node): void => {
                visit(child, nextParent);
            });
        };
        visit(file, `file:${path}`);
    });
    const symbolTarget: (node: ts.Node) => string | undefined = (node: ts.Node): string | undefined => {
        let symbol: ts.Symbol | undefined = checker.getSymbolAtLocation(node);
        if (symbol && symbol.flags & ts.SymbolFlags.Alias) {
            symbol = checker.getAliasedSymbol(symbol);
        }
        return symbol?.declarations
            ?.map((declaration: ts.Declaration): string | undefined => declarations.get(declaration))
            .find((id: string | undefined): boolean => id !== (void 0));
    };
    scripts.forEach((file: ts.SourceFile): void => {
        const path: string = file.fileName.slice(virtualRoot.length);
        let unresolvedCalls: number = 0;
        const visit: (node: ts.Node, parentId: string) => void = (node: ts.Node, parentId: string): void => {
            const current: string = declarations.get(node) ?? parentId;
            const origin: WorkspaceSource = source(path, file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1);
            const specifier: ts.Expression | undefined =
                ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
                    ? node.moduleSpecifier
                    : ts.isCallExpression(node) &&
                        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
                            (ts.isIdentifier(node.expression) &&
                                node.expression.text === "require" &&
                                !checker.getSymbolAtLocation(node.expression)?.declarations?.length))
                      ? node.arguments[0]
                      : (void 0);
            if (specifier && ts.isStringLiteralLike(specifier)) {
                const name: string = specifier.text;
                const resolved: ts.ResolvedModuleFull | undefined = ts.resolveModuleName(name, file.fileName, compilerOptions, host).resolvedModule;
                let target: string | undefined = resolved ? `file:${virtualPath(resolved.resolvedFileName).slice(virtualRoot.length)}` : (void 0);
                if (target === (void 0) || !entities.has(target)) {
                    const configuredAlias: boolean = Object.keys(compilerOptions.paths ?? {}).some((pattern: string): boolean => {
                        const parts: string[] = pattern.split("*");
                        return parts.length === 1 ? name === pattern : name.startsWith(parts[0]) && name.endsWith(parts[1]);
                    });
                    if (name.startsWith(".") || name.startsWith("/") || configuredAlias) {
                        diagnostics.push({ uri: path, code: "unresolved_import", message: name });
                        target = (void 0);
                    } else {
                        const packageName: string = name.startsWith("@") ? name.split("/").slice(0, 2).join("/") : name.split("/")[0];
                        const project: ProjectInput = owner(path);
                        target =
                            packages.get(JSON.stringify([project.id, packageName])) ??
                            external(project, packageName, origin, "external module; resolution not inspected");
                    }
                }
                if (target !== (void 0)) {
                    relations.push({ from: `file:${path}`, to: target, kind: "imports", source: origin, method: "compiler" });
                    const dependency: WorkspaceEntity = entities.get(target)!;
                    if (dependency.projectId !== owner(path).id) {
                        relations.push({ from: owner(path).id, to: dependency.projectId, kind: "project_depends_on", source: origin, method: "compiler" });
                    }
                }
            }
            if (ts.isCallExpression(node) && specifier === (void 0)) {
                const declaration: ts.Node | undefined = checker.getResolvedSignature(node)?.declaration;
                const target: string | undefined = (declaration ? declarations.get(declaration) : (void 0)) ?? symbolTarget(node.expression);
                if (target) {
                    relations.push({ from: current, to: target, kind: "calls", source: origin, method: "compiler" });
                } else {
                    unresolvedCalls += 1;
                }
            }
            if (ts.isIdentifier(node)) {
                const target: string | undefined = symbolTarget(node);
                if (target && target !== current) {
                    relations.push({ from: current, to: target, kind: "references", source: origin, method: "compiler" });
                }
            }
            ts.forEachChild(node, (child: ts.Node): void => {
                visit(child, current);
            });
        };
        visit(file, `file:${path}`);
        if (unresolvedCalls > 0) {
            diagnostics.push({ uri: path, code: "unresolved_calls", message: `${unresolvedCalls} calls have no indexed static target; graph is partial` });
        }
    });
    paths
        .filter((path: string): boolean => /\.md$/i.test(path))
        .forEach((path: string): void => {
            const lines: string[] = parseText(files.get(path)!).split(/\r?\n/);
            let fence: string = "";
            const markdownLines: string[] = lines.map((line: string): string => {
                const marker: string | undefined = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
                if (marker) {
                    if (!fence) {
                        fence = marker;
                    } else if (marker[0] === fence[0] && marker.length >= fence.length && /^\s{0,3}(?:`+|~+)\s*$/.test(line)) {
                        fence = "";
                    }
                    return "";
                }
                return fence ? "" : line.replace(/`+[^`]*`+/g, "");
            });
            const starts: number[] = [
                0,
                ...markdownLines
                    .map((line: string, index: number): number => (/^#{1,6}\s/.test(line) && index > 0 ? index : -1))
                    .filter((index: number): boolean => index >= 0),
            ];
            const sections: HeadingEntry[] = [];
            const nodes: WorkspaceEntity[] = [];
            const childrenByParent: Map<string, WorkspaceEntity[]> = new Map();
            starts.forEach((start: number, index: number): void => {
                const end: number = starts[index + 1] ?? lines.length;
                const text: string = lines.slice(start, end).join("\n");
                if (!text.trim()) {
                    return;
                }
                const id: string = `knowledge:${path}#L${start + 1}`;
                const level: number = /^(#{1,6})\s/.exec(markdownLines[start])?.[1].length ?? 0;
                while (sections.length > 0 && sections[sections.length - 1].level >= level) {
                    sections.pop();
                }
                entities.set(id, {
                    id,
                    kind: "knowledge",
                    projectId: owner(path).id,
                    parentId: sections.at(-1)?.id ?? `file:${path}`,
                    label: lines[start].replace(/^#+\s*/, "") || path,
                    summary: short(text),
                    source: source(path, start + 1, end),
                    detailRef: store.put(text),
                    searchTerms: workspaceTerms(text),
                    structureKind: "section",
                    summaryProvenance: { method: "extractive-v1", sources: [source(path)], children: [] },
                });
                const node: WorkspaceEntity = entities.get(id)!;
                nodes.push(node);
                const siblings: WorkspaceEntity[] = childrenByParent.get(node.parentId!) ?? [];
                siblings.push(node);
                childrenByParent.set(node.parentId!, siblings);
                sections.push({ id, level });
                const links: string = markdownLines.slice(start, end).join("\n");
                const matches: RegExpExecArray[] = [...links.matchAll(/\[[^\]]*\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)];
                for (let matchIndex: number = 0; matchIndex < matches.length; matchIndex += 1) {
                    const match: RegExpExecArray = matches[matchIndex];
                    const link: string = match[1].split("#")[0];
                    if (!link || /^[a-z][a-z0-9+.-]*:/i.test(link) || link.startsWith("/")) {
                        continue;
                    }
                    let targetPath: string;
                    try {
                        targetPath = posix.normalize(posix.join(posix.dirname(path), decodeURIComponent(link)));
                    } catch {
                        diagnostics.push({ uri: path, code: "unresolved_doc_link", message: link });
                        continue;
                    }
                    if (files.has(targetPath)) {
                        relations.push({ from: id, to: `file:${targetPath}`, kind: "documents", source: source(path, start + 1, end), method: "explicit" });
                    } else {
                        diagnostics.push({ uri: path, code: "unresolved_doc_link", message: link });
                    }
                }
            });
            nodes.forEach((entity: WorkspaceEntity): void => {
                const children: WorkspaceEntity[] = childrenByParent.get(entity.id) ?? [];
                entity.summaryProvenance!.children = children.map((child: WorkspaceEntity): string => child.id);
                if (children.length > 0) {
                    entity.summary = short(`${entity.summary} Sections: ${children.map((child: WorkspaceEntity): string => child.label).join("; ")}`);
                }
            });
            const file: WorkspaceEntity = entities.get(`file:${path}`)!;
            const roots: WorkspaceEntity[] = childrenByParent.get(file.id) ?? [];
            file.structureKind = "document";
            file.summary = short(`Markdown ${path}: ${roots.map((entity: WorkspaceEntity): string => entity.summary).join("; ")}`);
            file.summaryProvenance = { method: "extractive-v1", sources: [source(path)], children: roots.map((entity: WorkspaceEntity): string => entity.id) };
        });
    return { version: 1, revision, entities: [...entities.values()], relations, diagnostics };
};
