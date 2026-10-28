/**
 * Bounded, literal LaTeX structure and project adapter. Never expands macros,
 * executes TeX or resolves files outside the caller-provided inventory.
 */
import { posix } from "node:path";

import type { ContentStore } from "../../src/context/contentStore.ts";
import { encodeDocumentDetail } from "../../src/context/document.ts";
import type { TexDependency } from "../../src/context/document.ts";
import { workspaceTerms } from "../../src/context/workspace.ts";
import type { WorkspaceEntity, WorkspaceRelationKind, WorkspaceSnapshot, WorkspaceSource } from "../../src/context/workspace.ts";
import type { WorkspaceFile } from "./workspaceScanner.ts";

interface Group {
    value: string;
    end: number;
}

interface Token {
    name: string;
    value: string;
    start: number;
    end: number;
}

interface Block {
    start: number;
    end: number;
    label: string;
    type: "section" | "environment" | "paragraph";
    tag: string;
    level?: number;
    key?: string;
    node?: WorkspaceEntity;
    parent?: Block;
}

interface TexFile {
    path: string;
    text: string;
    tokens: Token[];
    blocks: Block[];
    lines: number[];
    file: WorkspaceEntity;
}

interface DependencyRequest {
    token: Token;
    path: string;
    value: string;
}

type TexAdapter = (snapshot: WorkspaceSnapshot, inputs: readonly WorkspaceFile[], store: ContentStore) => void;
type RelationAdder = (from: string, to: string, kind: WorkspaceRelationKind, source: WorkspaceSource) => void;

const Levels: Record<string, number> = { part: 0, chapter: 1, section: 2, subsection: 3, subsubsection: 4, paragraph: 5, subparagraph: 6 };
const Literals: Set<string> = new Set(["verbatim", "verbatim*", "Verbatim", "lstlisting", "minted", "comment", "filecontents", "filecontents*"]);
const Dependencies: Set<string> = new Set([
    "input",
    "include",
    "subfile",
    "bibliography",
    "addbibresource",
    "includegraphics",
    "documentclass",
    "usepackage",
    "RequirePackage",
    "LoadClass",
]);
const References: Set<string> = new Set(["ref", "eqref", "pageref", "autoref", "cref", "Cref", "vref", "nameref"]);
const Definitions: Set<string> = new Set(["newcommand", "renewcommand", "providecommand", "DeclareRobustCommand", "newenvironment", "renewenvironment"]);
const short: (value: string) => string = (value: string): string => value.replace(/\s+/g, " ").trim().slice(0, 180);
const skipSpace: (text: string, start: number) => number = (text: string, start: number): number => {
    let offset: number = start;
    while (offset < text.length) {
        if (/\s/.test(text[offset])) {
            offset += 1;
        } else if (text[offset] === "%") {
            offset = text.indexOf("\n", offset);
            if (offset < 0) {
                return text.length;
            }
        } else {
            break;
        }
    }
    return offset;
};

const group: (text: string, start: number, open?: string) => Group | undefined = (text: string, start: number, open: string = "{"): Group | undefined => {
    const begin: number = skipSpace(text, start);
    if (text[begin] !== open) {
        return (void 0);
    }
    const close: string = open === "{" ? "}" : open === "[" ? "]" : ")";
    let depth: number = 1;
    let braces: number = 0;
    let value: string = "";
    for (let offset: number = begin + 1; offset < text.length; offset += 1) {
        const char: string = text[offset];
        if (char === "\\") {
            value += text.slice(offset, offset + 2);
            offset += 1;
            continue;
        }
        if (char === "%") {
            const newline: number = text.indexOf("\n", offset);
            offset = newline < 0 ? text.length : newline;
            value += "\n";
            continue;
        }
        if (open === "[" && char === "{") {
            braces += 1;
        } else if (open === "[" && char === "}") {
            braces -= 1;
        }
        if (braces === 0 && char === open) {
            depth += 1;
        } else if (braces === 0 && char === close) {
            depth -= 1;
            if (depth === 0) {
                return { value, end: offset + 1 };
            }
        }
        if (depth + braces > 128 || braces < 0) {
            throw new Error("TeX group nesting exceeds bounds");
        }
        value += char;
    }
    throw new Error("Unclosed TeX argument group");
};

const tokens: (text: string) => Token[] = (text: string): Token[] => {
    const result: Token[] = [];
    let offset: number = 0;
    while (offset < text.length) {
        if (text[offset] === "%") {
            offset = text.indexOf("\n", offset);
            if (offset < 0) {
                break;
            }
        }
        if (text[offset] !== "\\") {
            offset += 1;
            continue;
        }
        const start: number = offset;
        const match: RegExpExecArray | null = /^\\([A-Za-z@]+|[^\r\n])/.exec(text.slice(offset));
        if (!match) {
            offset += 1;
            continue;
        }
        const name: string = match[1];
        offset += match[0].length;
        if (text[offset] === "*") {
            offset += 1;
        }
        if (name === "verb") {
            const delimiter: string = text[offset];
            const end: number = delimiter ? text.indexOf(delimiter, offset + 1) : -1;
            const newline: number = text.indexOf("\n", offset);
            offset = end >= 0 && (newline < 0 || end < newline) ? end + 1 : newline < 0 ? text.length : newline;
            continue;
        }
        if (["def", "gdef", "edef", "xdef"].includes(name)) {
            const body: number = text.indexOf("{", offset);
            offset = body < 0 ? text.length : group(text, body)!.end;
            continue;
        }
        if (Definitions.has(name)) {
            const macro: Group | undefined = group(text, offset);
            offset = macro?.end ?? skipSpace(text, offset);
            if (!macro) {
                offset += /^\\[A-Za-z@]+/.exec(text.slice(offset))?.[0].length ?? 0;
            }
            let option: Group | undefined = group(text, offset, "[");
            while (option) {
                offset = option.end;
                option = group(text, offset, "[");
            }
            const body: Group | undefined = group(text, offset);
            offset = body?.end ?? offset;
            if (name.endsWith("environment")) {
                offset = group(text, offset)?.end ?? offset;
            }
            continue;
        }
        if (
            !Object.hasOwn(Levels, name) &&
            !["begin", "end", "label", "title"].includes(name) &&
            !Dependencies.has(name) &&
            !References.has(name) &&
            !/^(?:[A-Za-z]*cite[A-Za-z]*|nocite)$/.test(name)
        ) {
            continue;
        }
        let option: Group | undefined = group(text, offset, "[");
        while (option) {
            offset = option.end;
            option = group(text, offset, "[");
        }
        let argument: Group | undefined = group(text, offset);
        if (!argument && name === "input") {
            const begin: number = skipSpace(text, offset);
            const filename: string = /^[^\s%{}\\]+/.exec(text.slice(begin))?.[0] ?? "";
            if (filename) {
                argument = { value: filename, end: begin + filename.length };
            }
        }
        if (!argument) {
            result.push({ name, value: "", start, end: offset });
            continue;
        }
        offset = argument.end;
        result.push({ name, value: argument.value.trim(), start, end: offset });
        if (name === "begin" && Literals.has(argument.value.trim())) {
            const closing: string = `\\end{${argument.value.trim()}}`;
            const end: number = text.indexOf(closing, offset);
            if (end < 0) {
                throw new Error(`Unclosed literal environment ${argument.value}`);
            }
            result.push({ name: "end", value: argument.value.trim(), start: end, end: end + closing.length });
            offset = end + closing.length;
        }
    }
    return result;
};

const bibBlocks: (text: string) => Block[] = (text: string): Block[] => {
    const blocks: Block[] = [];
    let offset: number = 0;
    while (offset < text.length) {
        if (text[offset] === "%") {
            const end: number = text.indexOf("\n", offset);
            offset = end < 0 ? text.length : end + 1;
            continue;
        }
        const match: RegExpExecArray | null = /^@([A-Za-z]+)\s*([{(])/.exec(text.slice(offset));
        if (!match) {
            offset += 1;
            continue;
        }
        const start: number = offset;
        const open: string = match[2];
        offset += match[0].length;
        const bodyStart: number = offset;
        let braces: number = open === "{" ? 1 : 0;
        let quoted: boolean = false;
        while (offset < text.length) {
            const char: string = text[offset];
            if (char === "\\") {
                offset += 2;
                continue;
            }
            if (char === '"' && (braces === 0 || (open === "{" && braces === 1))) {
                quoted = !quoted;
            }
            if (!quoted && char === "{") {
                braces += 1;
            } else if (!quoted && char === "}") {
                braces -= 1;
                if (open === "{" && braces === 0) {
                    break;
                }
            } else if (!quoted && open === "(" && char === ")" && braces === 0) {
                break;
            }
            if (braces > 128) {
                throw new Error("BibTeX nesting exceeds 128");
            }
            offset += 1;
        }
        if (offset >= text.length) {
            throw new Error("Unclosed BibTeX entry");
        }
        const type: string = match[1].toLowerCase();
        const key: string = text.slice(bodyStart, offset).split(",")[0].trim();
        offset += 1;
        if (!["comment", "preamble", "string"].includes(type) && key && !/[\s{}]/.test(key)) {
            blocks.push({ start, end: offset, label: key, type: "paragraph", tag: `bibtex:${type}`, key });
        }
    }
    return blocks;
};

/**
 * Adds format facts to the shared snapshot. LaTeX build projects are knowledge
 * views under their root files, not replacements for workspace ownership.
 */
export const addTexStructure: TexAdapter = (snapshot: WorkspaceSnapshot, inputs: readonly WorkspaceFile[], store: ContentStore): void => {
    const entities: Map<string, WorkspaceEntity> = new Map(snapshot.entities.map((entity: WorkspaceEntity): [string, WorkspaceEntity] => [entity.id, entity]));
    const parsed: Map<string, TexFile> = new Map();
    const roots: Set<string> = new Set();
    const requests: Map<string, DependencyRequest[]> = new Map();
    const keys: Set<string> = new Set();
    const covered: Set<string> = new Set();
    const edge: RelationAdder = (from, to, kind, source): void => {
        const key: string = JSON.stringify([from, to, kind, source.uri, source.startLine]);
        if (!keys.has(key)) {
            keys.add(key);
            snapshot.relations.push({ from, to, kind, source, method: "explicit" });
        }
    };
    const diagnostic: (path: string, code: string, message: string) => void = (path: string, code: string, message: string): void => {
        snapshot.diagnostics.push({ uri: path, code, message });
    };
    const line: (file: TexFile, offset: number) => number = (file: TexFile, offset: number): number => {
        let low: number = 0;
        let high: number = file.lines.length;
        while (low < high) {
            const middle: number = (low + high) >>> 1;
            if (file.lines[middle] <= offset) {
                low = middle + 1;
            } else {
                high = middle;
            }
        }
        return low;
    };
    const source: (file: TexFile, start: number, end: number) => WorkspaceSource = (file: TexFile, start: number, end: number): WorkspaceSource => ({
        ...file.file.source,
        startLine: line(file, start),
        endLine: line(file, Math.max(start, end - 1)),
        locator: { kind: "part", part: file.path, element: `chars:${start}:${end}` },
    });
    inputs
        .filter((input: WorkspaceFile): boolean => /\.(?:tex|ltx|sty|cls|bib)$/i.test(input.path))
        .forEach((input: WorkspaceFile): void => {
            const file: TexFile = {
                path: input.path,
                text: input.content,
                tokens: [],
                blocks: [],
                lines: [0, ...[...input.content.matchAll(/\n/g)].map((match: RegExpMatchArray): number => match.index! + 1)],
                file: entities.get(`file:${input.path}`)!,
            };
            try {
                if (Buffer.byteLength(file.text) > 16 * 1024 * 1024) {
                    throw new Error("TeX source exceeds 16 MiB");
                }
                if (/\.bib$/i.test(file.path)) {
                    file.blocks = bibBlocks(file.text);
                } else {
                    file.tokens = tokens(file.text);
                    const sections: Block[] = [];
                    const environments: Block[] = [];
                    file.tokens.forEach((token: Token): void => {
                        if (Object.hasOwn(Levels, token.name) && token.value) {
                            const level: number = Levels[token.name];
                            while (sections.length > 0 && sections.at(-1)!.level! >= level) {
                                sections.pop()!.end = token.start;
                            }
                            const block: Block = { start: token.start, end: file.text.length, label: token.value, type: "section", tag: token.name, level };
                            sections.push(block);
                            file.blocks.push(block);
                        } else if (token.name === "begin" && token.value && token.value !== "document") {
                            const block: Block = { start: token.start, end: file.text.length, label: token.value, type: "environment", tag: token.value };
                            environments.push(block);
                            file.blocks.push(block);
                        } else if (token.name === "end" && token.value !== "document") {
                            if (environments.at(-1)?.tag === token.value) {
                                environments.pop()!.end = token.end;
                            } else {
                                diagnostic(file.path, "tex_environment_mismatch", `Unmatched \\end{${token.value}} at line ${line(file, token.start)}`);
                            }
                        }
                    });
                    environments.forEach((block: Block): void =>
                        diagnostic(file.path, "tex_environment_mismatch", `Unclosed ${block.tag} at line ${line(file, block.start)}`),
                    );
                    const list: DependencyRequest[] = [];
                    file.tokens
                        .filter((token: Token): boolean => Dependencies.has(token.name))
                        .forEach((token: Token): void => {
                            const values: string[] = ["bibliography", "usepackage", "RequirePackage"].includes(token.name)
                                ? token.value.split(",")
                                : [token.value];
                            values.forEach((value: string): void => {
                                list.push({ path: file.path, token, value: value.trim() });
                            });
                        });
                    requests.set(file.path, list);
                }
            } catch (error) {
                diagnostic(file.path, "invalid_tex", error instanceof Error ? error.message : "TeX parsing failed");
                return;
            }
            file.blocks.sort((left: Block, right: Block): number => left.start - right.start || right.end - left.end);
            const active: Block[] = [];
            const children: Map<string, WorkspaceEntity[]> = new Map();
            file.blocks.forEach((block: Block): void => {
                while (active.length > 0 && (active.at(-1)!.end < block.end || active.at(-1)!.end <= block.start)) {
                    active.pop();
                }
                const parentId: string = active.at(-1)?.node?.id ?? file.file.id;
                block.parent = active.at(-1);
                const body: string = file.text.slice(block.start, block.end);
                const node: WorkspaceEntity = {
                    id: `knowledge:${file.path}#tex:${block.start}`,
                    kind: "knowledge",
                    projectId: file.file.projectId,
                    parentId,
                    label: block.label,
                    summary: short(`${block.tag} ${block.label}: ${body}`),
                    source: source(file, block.start, block.end),
                    structureKind: block.type,
                    tags: ["latex", block.tag],
                    searchTerms: workspaceTerms(body),
                    detailRef: store.put(encodeDocumentDetail({ kind: "text", text: body })),
                    summaryProvenance: { method: "extractive-v1", sources: [{ uri: file.path, revision: file.file.source.revision }], children: [] },
                };
                block.node = node;
                entities.set(node.id, node);
                const siblings: WorkspaceEntity[] = children.get(parentId) ?? [];
                siblings.push(node);
                children.set(parentId, siblings);
                active.push(block);
            });
            file.blocks.forEach((block: Block): void => {
                const node: WorkspaceEntity = block.node!;
                const nested: WorkspaceEntity[] = children.get(node.id) ?? [];
                node.summaryProvenance!.children = nested.map((child: WorkspaceEntity): string => child.id);
                node.summary = short(
                    `${block.tag} ${block.label}; ${nested.map((child: WorkspaceEntity): string => child.label).join("; ")} ${file.text.slice(block.start, block.end)}`,
                );
            });
            file.file.structureKind = "document";
            file.file.tags = [...(file.file.tags ?? []), /\.bib$/i.test(file.path) ? "bibtex" : "latex"];
            file.file.summary = short(`${file.path}: ${file.blocks.map((block: Block): string => block.label).join("; ")} ${file.text}`);
            file.file.searchTerms = workspaceTerms(file.text);
            file.file.summaryProvenance = {
                method: "extractive-v1",
                sources: [{ uri: file.path, revision: file.file.source.revision }],
                children: (children.get(file.file.id) ?? []).map((child: WorkspaceEntity): string => child.id),
            };
            parsed.set(file.path, file);
            if (file.tokens.some((token: Token): boolean => token.name === "documentclass" || (token.name === "begin" && token.value === "document"))) {
                roots.add(file.path);
            }
            diagnostic(
                file.path,
                "tex_static_partial",
                "Literal structure only: no macro expansion, catcode/conditional evaluation, compilation, TeX search paths or BibTeX string expansion",
            );
        });
    const owner: (file: TexFile, offset: number) => string = (file: TexFile, offset: number): string => {
        let low: number = 0;
        let high: number = file.blocks.length;
        while (low < high) {
            const middle: number = (low + high) >>> 1;
            if (file.blocks[middle].start <= offset) {
                low = middle + 1;
            } else {
                high = middle;
            }
        }
        let block: Block | undefined = low > 0 ? file.blocks[low - 1] : (void 0);
        while (block && block.end <= offset) {
            block = block.parent;
        }
        return block?.node?.id ?? file.file.id;
    };
    const resolve: (request: DependencyRequest, root: string) => string | undefined = (request: DependencyRequest, root: string): string | undefined => {
        const value: string = request.value;
        if (!value || /[\\{}#$\x00-\x1f]/.test(value) || posix.isAbsolute(value) || /^[a-z][a-z0-9+.-]*:/i.test(value)) {
            return (void 0);
        }
        const command: string = request.token.name;
        const extensions: string[] = ["bibliography", "addbibresource"].includes(command)
            ? [".bib"]
            : command === "includegraphics"
              ? [".pdf", ".png", ".jpg", ".jpeg", ".eps", ".svg"]
              : ["usepackage", "RequirePackage"].includes(command)
                ? [".sty"]
                : ["documentclass", "LoadClass"].includes(command)
                  ? [".cls"]
                  : [".tex", ".ltx"];
        const names: string[] = posix.extname(value) ? [value] : extensions.map((extension: string): string => `${value}${extension}`);
        const bases: string[] = [...new Set([posix.dirname(root), posix.dirname(request.path)])];
        for (let baseIndex: number = 0; baseIndex < bases.length; baseIndex += 1) {
            const base: string = bases[baseIndex];
            for (let index: number = 0; index < names.length; index += 1) {
                const path: string = posix.normalize(posix.join(base, names[index]));
                if (!path.startsWith("../") && entities.has(`file:${path}`)) {
                    return path;
                }
            }
        }
        return (void 0);
    };
    parsed.forEach((file: TexFile): void => {
        const hint: string | undefined = /^\s*%\s*!\s*TeX\s+root\s*=\s*(.+?)\s*$/im.exec(file.text)?.[1];
        if (hint) {
            const path: string = posix.normalize(posix.join(posix.dirname(file.path), hint));
            if (parsed.has(path)) {
                roots.add(path);
            } else {
                diagnostic(file.path, "tex_unresolved_root", hint);
            }
        }
    });
    const visit: (root: string, project: boolean) => void = (root: string, project: boolean): void => {
        const pending: string[] = [root];
        const seen: Set<string> = new Set();
        const dependencies: TexDependency[] = [];
        const projectId: string = `knowledge:${root}#latex-project`;
        while (pending.length > 0) {
            const path: string = pending.pop()!;
            if (seen.has(path)) {
                continue;
            }
            seen.add(path);
            covered.add(path);
            const file: TexFile | undefined = parsed.get(path);
            if (!file) {
                continue;
            }
            (requests.get(path) ?? []).forEach((request: DependencyRequest): void => {
                const target: string | undefined = resolve(request, root);
                const origin: WorkspaceSource = source(file, request.token.start, request.token.end);
                if (target) {
                    dependencies.push({ from: path, to: target, command: request.token.name });
                    edge(file.file.id, `file:${target}`, "imports", origin);
                    edge(owner(file, request.token.start), `file:${target}`, "imports", origin);
                    if (!seen.has(target)) {
                        pending.push(target);
                    }
                } else if (["documentclass", "usepackage", "RequirePackage", "LoadClass"].includes(request.token.name) && /^[\w.-]+$/.test(request.value)) {
                    const id: string = `package:${JSON.stringify(["latex", file.file.projectId, request.token.name, request.value])}`;
                    if (!entities.has(id)) {
                        entities.set(id, {
                            id,
                            kind: "package",
                            projectId: file.file.projectId,
                            parentId: file.file.projectId,
                            label: request.value,
                            summary: `Declared TeX ${request.token.name}: ${request.value}; installation/version unverified`,
                            source: origin,
                            tags: ["latex", request.token.name],
                        });
                    }
                    edge(file.file.id, id, "imports", origin);
                } else {
                    diagnostic(path, "tex_unresolved_dependency", `${request.token.name}{${request.value}} from root ${root}`);
                }
            });
        }
        const labels: Map<string, string[]> = new Map();
        const citations: Map<string, string[]> = new Map();
        const addKey: (map: Map<string, string[]>, key: string, id: string) => void = (map: Map<string, string[]>, key: string, id: string): void => {
            const ids: string[] = map.get(key) ?? [];
            ids.push(id);
            map.set(key, ids);
        };
        seen.forEach((path: string): void => {
            const file: TexFile | undefined = parsed.get(path);
            file?.tokens
                .filter((token: Token): boolean => token.name === "label")
                .forEach((token: Token): void => addKey(labels, token.value, owner(file, token.start)));
            file?.blocks.filter((block: Block): boolean => Boolean(block.key)).forEach((block: Block): void => addKey(citations, block.key!, block.node!.id));
        });
        seen.forEach((path: string): void => {
            const file: TexFile | undefined = parsed.get(path);
            file?.tokens.forEach((token: Token): void => {
                const cite: boolean = /^(?:[A-Za-z]*cite[A-Za-z]*|nocite)$/.test(token.name);
                if (!cite && !References.has(token.name)) {
                    return;
                }
                token.value
                    .split(",")
                    .map((value: string): string => value.trim())
                    .forEach((key: string): void => {
                        if (token.name === "nocite" && key === "*") {
                            citations.forEach((ids: string[]): void =>
                                ids.forEach((id: string): void => edge(owner(file, token.start), id, "references", source(file, token.start, token.end))),
                            );
                            return;
                        }
                        const targets: string[] = (cite ? citations : labels).get(key) ?? [];
                        if (targets.length === 1) {
                            edge(owner(file, token.start), targets[0], "references", source(file, token.start, token.end));
                        } else {
                            diagnostic(path, targets.length > 1 ? "tex_ambiguous_reference" : "tex_unresolved_reference", `${token.name}{${key}} in ${root}`);
                        }
                    });
            });
        });
        if (!project) {
            return;
        }
        const file: TexFile = parsed.get(root)!;
        const paths: string[] = [...seen].sort();
        const names: string = paths
            .flatMap(
                (path: string): string[] =>
                    parsed
                        .get(path)
                        ?.blocks.filter((block: Block): boolean => block.type === "section")
                        .map((block: Block): string => block.label) ?? [],
            )
            .join("; ");
        entities.set(projectId, {
            id: projectId,
            kind: "knowledge",
            projectId: file.file.projectId,
            parentId: file.file.id,
            label: `LaTeX project: ${root}`,
            summary: short(`LaTeX project ${root}, ${paths.length} supplied files: ${names}`),
            structureKind: "document",
            tags: ["latex", "latex-project"],
            source: { ...file.file.source },
            searchTerms: workspaceTerms(`${root} ${paths.join(" ")} ${names}`),
            detailRef: store.put(encodeDocumentDetail({ kind: "tex-project", root, files: paths, dependencies })),
            summaryProvenance: {
                method: "extractive-v1",
                sources: paths.map((path: string) => ({ uri: path, revision: entities.get(`file:${path}`)!.source.revision })),
                children: [],
            },
        });
        paths.forEach((path: string): void => edge(projectId, `file:${path}`, "documents", file.file.source));
    };
    [...roots]
        .sort()
        .filter((path: string): boolean => parsed.has(path))
        .forEach((path: string): void => visit(path, true));
    [...parsed.keys()]
        .sort()
        .filter((path: string): boolean => /\.(?:tex|ltx)$/i.test(path) && !covered.has(path))
        .forEach((path: string): void => visit(path, false));
    snapshot.entities = [...entities.values()];
};
