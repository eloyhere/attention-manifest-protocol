/**
 * Deterministic, bounded metadata extraction for tree nodes.
 *
 * Descriptions are derived only from bytes the caller already has: a leading
 * JSDoc or line comment, a Markdown heading and paragraph, front matter, a
 * package manifest or the first paragraph of plain text. Extraction never
 * touches the filesystem, never executes code and never inspects more than the
 * first 64 KiB of a file, so building a tree stays cheap and side-effect free.
 *
 * The three fields have different jobs. `description` is a short identity line,
 * `summary` adds detail for retrieval and `purpose` records what the host or the
 * document explicitly says the node is for. Host annotations override all three,
 * but they are descriptive only: they never change a fingerprint.
 */
import type { Charset } from "../syntax/types.ts";
import type { NodeAnnotation, TreeNode } from "./types.ts";
import { decodeText } from "../syntax/charset.ts";

const MaxHeadBytes: number = 64 * 1024;
const MaxDescriptionLength: number = 160;
const MaxSummaryLength: number = 400;
const MaxPurposeLength: number = 200;
const MaxSummaryChildren: number = 6;

const ScriptExtensions: ReadonlySet<string> = new Set<string>([
    "js",
    "jsx",
    "mjs",
    "cjs",
    "ts",
    "tsx",
    "mts",
    "cts",
    "java",
    "kt",
    "kts",
    "c",
    "h",
    "cc",
    "cpp",
    "hpp",
    "cs",
    "go",
    "rs",
    "swift",
]);

const MarkdownExtensions: ReadonlySet<string> = new Set<string>(["md", "markdown", "mdx"]);

/**
 * Descriptive fields derived for one node.
 */
export interface NodeDescription {
    readonly description: string;
    readonly summary: string;
    readonly purpose: string;
}

interface FrontMatter {
    readonly title?: string;
    readonly description?: string;
    readonly purpose?: string;
    readonly body: string;
}

interface CommentExtraction {
    readonly text: string;
    readonly purpose?: string;
}

interface FrontMatterFields {
    title?: string;
    description?: string;
    purpose?: string;
}

const collapse: (value: string) => string = (value: string): string => value.replace(/\s+/gu, " ").trim();

const safeSliceEnd: (value: string, end: number) => number = (value: string, end: number): number => {
    let cut: number = Math.min(end, value.length);
    if (cut > 0 && cut < value.length) {
        const code: number = value.charCodeAt(cut - 1);
        if (code >= 0xd800 && code <= 0xdbff) {
            cut -= 1;
        }
    }
    return cut;
};

const clip: (value: string, maximum: number) => string = (value: string, maximum: number): string => {
    if (value.length <= maximum) {
        return value;
    }
    const cut: number = safeSliceEnd(value, Math.max(0, maximum - 3));
    return `${value.slice(0, cut)}...`;
};

const normalizeField: (value: string, maximum: number) => string = (value: string, maximum: number): string =>
    clip(collapse(value), maximum);

/**
 * Last path segment, accepting both POSIX and host separators so an absolute
 * path is usable as a name fallback. The root path normalizes to `.`.
 */
export const nameOfPath: (value: string) => string = (value: string): string => {
    const normalized: string = value.replace(/\\/g, "/").replace(/\/+$/, "");
    if (normalized.length === 0 || normalized === ".") {
        return ".";
    }
    const slash: number = normalized.lastIndexOf("/");
    return slash === -1 ? normalized : normalized.slice(slash + 1);
};

/**
 * Last lowercase extension without the dot; the empty string when the name has
 * no extension. A leading dot is a hidden-file marker, not an extension.
 */
export const extensionOfPath: (value: string) => string = (value: string): string => {
    const name: string = nameOfPath(value);
    const dot: number = name.lastIndexOf(".");
    if (dot <= 0 || dot === name.length - 1) {
        return "";
    }
    return name.slice(dot + 1).toLowerCase();
};

const decodePreview: (head: Uint8Array, charset: Charset) => string | undefined = (head: Uint8Array, charset: Charset): string | undefined => {
    if (charset === "binary" || charset === "none") {
        return undefined;
    }
    const bounded: Uint8Array = head.length > MaxHeadBytes ? head.subarray(0, MaxHeadBytes) : head;
    const even: Uint8Array = charset === "utf-16le" || charset === "utf-16be" ? bounded.subarray(0, bounded.length - (bounded.length % 2)) : bounded;
    for (let trim: number = 0; trim <= 3; trim += 1) {
        const candidate: Uint8Array = trim === 0 ? even : even.subarray(0, Math.max(0, even.length - trim));
        try {
            return decodeText(candidate, charset);
        } catch {
            continue;
        }
    }
    return undefined;
};

const stripQuotes: (value: string) => string = (value: string): string => {
    const trimmed: string = value.trim();
    if (trimmed.length >= 2) {
        const first: string = trimmed[0];
        const last: string = trimmed[trimmed.length - 1];
        if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
            return trimmed.slice(1, -1).trim();
        }
    }
    return trimmed;
};

const parseFrontMatter: (text: string) => FrontMatter = (text: string): FrontMatter => {
    const normalized: string = text.replace(/\r\n?/g, "\n").replace(/^\uFEFF/, "");
    const lines: string[] = normalized.split("\n");
    if (lines.length === 0 || lines[0].trim() !== "---") {
        return { body: normalized };
    }
    let closing: number = -1;
    for (let index: number = 1; index < lines.length; index += 1) {
        const marker: string = lines[index].trim();
        if (marker === "---" || marker === "...") {
            closing = index;
            break;
        }
    }
    if (closing === -1) {
        return { body: normalized };
    }
    const fields: FrontMatterFields = {};
    for (let index: number = 1; index < closing; index += 1) {
        const match: RegExpExecArray | null = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(lines[index]);
        if (match === null) {
            continue;
        }
        const key: string = match[1].toLowerCase();
        const value: string = stripQuotes(match[2]);
        if (value.length === 0) {
            continue;
        }
        if (key === "title" && fields.title === (void 0)) {
            fields.title = value;
        } else if (key === "description" && fields.description === (void 0)) {
            fields.description = value;
        } else if (key === "purpose" && fields.purpose === (void 0)) {
            fields.purpose = value;
        }
    }
    return {
        title: fields.title,
        description: fields.description,
        purpose: fields.purpose,
        body: lines.slice(closing + 1).join("\n"),
    };
};

const firstNonEmptyLine: (text: string) => string | undefined = (text: string): string | undefined => {
    const lines: string[] = text.replace(/\r\n?/g, "\n").split("\n");
    for (let index: number = 0; index < lines.length; index += 1) {
        const trimmed: string = lines[index].trim();
        if (trimmed.length > 0) {
            return trimmed;
        }
    }
    return undefined;
};

const firstParagraph: (text: string) => string | undefined = (text: string): string | undefined => {
    const raw: string[] = text.replace(/\r\n?/g, "\n").split("\n");
    const lines: string[] = [];
    for (let index: number = 0; index < raw.length; index += 1) {
        const line: string = raw[index].trim();
        const next: string = index + 1 < raw.length ? raw[index + 1].trim() : "";
        if (line.length > 0 && !line.startsWith("#") && /^=+\s*$/.test(next)) {
            lines.push("");
            index += 1;
            continue;
        }
        lines.push(line);
    }
    const collected: string[] = [];
    let started: boolean = false;
    let fence: boolean = false;
    for (let index: number = 0; index < lines.length; index += 1) {
        const line: string = lines[index].trim();
        const fenceLine: boolean = line.startsWith("```") || line.startsWith("~~~");
        if (fenceLine) {
            if (started) {
                break;
            }
            fence = !fence;
            continue;
        }
        if (fence) {
            continue;
        }
        if (!started) {
            if (line.length === 0 || line.startsWith("#")) {
                continue;
            }
            started = true;
        } else if (line.length === 0 || line.startsWith("#")) {
            break;
        }
        collected.push(line);
    }
    return collected.length === 0 ? undefined : collected.join(" ");
};

const firstMarkdownHeading: (text: string) => string | undefined = (text: string): string | undefined => {
    const lines: string[] = text.replace(/\r\n?/g, "\n").split("\n");
    let fence: boolean = false;
    for (let index: number = 0; index < lines.length; index += 1) {
        const line: string = lines[index].trim();
        if (line.startsWith("```") || line.startsWith("~~~")) {
            fence = !fence;
            continue;
        }
        if (fence) {
            continue;
        }
        const match: RegExpExecArray | null = /^#\s+(.+?)\s*#*\s*$/.exec(line);
        if (match !== null) {
            return match[1].trim();
        }
        const next: string = index + 1 < lines.length ? lines[index + 1].trim() : "";
        if (line.length > 0 && !line.startsWith("#") && /^=+\s*$/.test(next)) {
            return line;
        }
    }
    return undefined;
};

const cleanComment: (lines: readonly string[]) => CommentExtraction = (lines: readonly string[]): CommentExtraction => {
    const cleaned: string[] = [];
    let purpose: string | undefined;
    for (let index: number = 0; index < lines.length; index += 1) {
        let value: string = lines[index].trim();
        if (value.startsWith("*")) {
            value = value.replace(/^\*+\s?/, "").trim();
        }
        if (value.length === 0) {
            cleaned.push("");
            continue;
        }
        const tag: RegExpExecArray | null = /^@([A-Za-z][A-Za-z0-9_-]*)\s*(.*)$/.exec(value);
        if (tag !== null) {
            if (tag[1].toLowerCase() === "purpose") {
                purpose = tag[2].trim();
            }
            continue;
        }
        cleaned.push(value);
    }
    return { text: cleaned.join("\n").trim(), purpose };
};

const extractLeadingComment: (text: string) => CommentExtraction | undefined = (text: string): CommentExtraction | undefined => {
    const lines: string[] = text.replace(/\r\n?/g, "\n").split("\n");
    let index: number = 0;
    while (index < lines.length && lines[index].trim().length === 0) {
        index += 1;
    }
    if (index < lines.length && lines[index].trimStart().startsWith("#!")) {
        index += 1;
    }
    while (index < lines.length && lines[index].trim().length === 0) {
        index += 1;
    }
    if (index >= lines.length) {
        return undefined;
    }
    const first: string = lines[index].trimStart();
    if (first.startsWith("/*")) {
        const raw: string[] = [];
        let closed: boolean = false;
        for (; index < lines.length; index += 1) {
            const line: string = lines[index];
            const open: number = line.indexOf("/*");
            const content: string = line.slice(open === -1 ? 0 : open + 2);
            const close: number = content.indexOf("*/");
            raw.push(close === -1 ? content : content.slice(0, close));
            if (close !== -1) {
                closed = true;
                break;
            }
        }
        return closed ? cleanComment(raw) : undefined;
    }
    if (first.startsWith("//")) {
        const raw: string[] = [];
        for (; index < lines.length; index += 1) {
            const trimmed: string = lines[index].trim();
            if (trimmed.startsWith("//")) {
                raw.push(trimmed.slice(2));
                continue;
            }
            if (trimmed.length === 0) {
                raw.push("");
                continue;
            }
            break;
        }
        return raw.length === 0 ? undefined : cleanComment(raw);
    }
    return undefined;
};

const describePackage: (text: string, relative: string) => NodeDescription | undefined = (text: string, relative: string): NodeDescription | undefined => {
    if (nameOfPath(relative).toLowerCase() !== "package.json") {
        return undefined;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        return undefined;
    }
    if (typeof(parsed) !== "object" || parsed === null) {
        return undefined;
    }
    const record: Record<string, unknown> = parsed as Record<string, unknown>;
    const packageName: string = typeof(record.name) === "string" ? collapse(record.name) : "";
    const declared: string = typeof(record.description) === "string" ? collapse(record.description) : "";
    const description: string = packageName.length > 0 ? `Package ${packageName}.` : "File package.json.";
    const summary: string = declared.length > 0 ? declared : description;
    return {
        description: normalizeField(description, MaxDescriptionLength),
        summary: normalizeField(summary, MaxSummaryLength),
        purpose: "not declared",
    };
};

const withAnnotation: (base: NodeDescription, annotation?: NodeAnnotation) => NodeDescription = (base: NodeDescription, annotation?: NodeAnnotation): NodeDescription => {
    if (annotation === (void 0)) {
        return base;
    }
    const description: string = annotation.description === (void 0) ? base.description : normalizeField(annotation.description, MaxDescriptionLength);
    const summary: string = annotation.summary === (void 0) ? base.summary : normalizeField(annotation.summary, MaxSummaryLength);
    const purpose: string = annotation.purpose === (void 0) ? base.purpose : normalizeField(annotation.purpose, MaxPurposeLength);
    return { description, summary, purpose };
};

/**
 * Derive description/summary/purpose for one file from its detected charset and
 * a bounded head of its bytes.
 *
 * @param absolute - Absolute host path, used only as a name fallback.
 * @param relative - Root-relative POSIX path.
 * @param charset - Detected charset; `binary`/`none` disable text extraction.
 * @param head - First bytes of the file; at most 64 KiB are inspected.
 * @param annotation - Optional host override.
 * @returns The three descriptive fields.
 */
export const describeFile: (absolute: string, relative: string, charset: Charset, head: Uint8Array, annotation?: NodeAnnotation) => NodeDescription = (absolute: string, relative: string, charset: Charset, head: Uint8Array, annotation?: NodeAnnotation): NodeDescription => {
    const nameFromPath: string = relative === "." || relative.length === 0 ? absolute : relative;
    const name: string = nameOfPath(nameFromPath);
    const fallback: NodeDescription = {
        description: normalizeField(`File ${name}.`, MaxDescriptionLength),
        summary: normalizeField(`File ${name}.`, MaxSummaryLength),
        purpose: "not declared",
    };
    const text: string | undefined = decodePreview(head, charset);
    let description: string | undefined;
    let summary: string | undefined;
    let purpose: string | undefined;
    if (text !== (void 0)) {
        const front: FrontMatter = parseFrontMatter(text);
        const body: string = front.body;
        const extension: string = extensionOfPath(relative);
        const isPackage: boolean = nameOfPath(relative).toLowerCase() === "package.json";
        const packageDescription: NodeDescription | undefined = describePackage(text, relative);
        if (packageDescription !== (void 0)) {
            description = packageDescription.description;
            summary = packageDescription.summary;
            purpose = packageDescription.purpose;
        } else if (isPackage) {
            description = "File package.json.";
            summary = description;
        } else if (MarkdownExtensions.has(extension)) {
            description = firstMarkdownHeading(body) ?? firstNonEmptyLine(body);
            summary = firstParagraph(body) ?? description;
        } else if (ScriptExtensions.has(extension)) {
            const comment: CommentExtraction | undefined = extractLeadingComment(body);
            if (comment !== (void 0)) {
                purpose = comment.purpose;
            }
            if (comment !== (void 0) && comment.text.length > 0) {
                description = firstNonEmptyLine(comment.text);
                summary = collapse(comment.text);
            } else {
                description = firstNonEmptyLine(body);
                summary = firstParagraph(body);
            }
        } else {
            description = firstNonEmptyLine(body);
            summary = firstParagraph(body);
        }
        if (front.title !== (void 0)) {
            description = front.title;
        }
        if (front.description !== (void 0)) {
            summary = front.description;
        }
        if (front.purpose !== (void 0)) {
            purpose = front.purpose;
        }
    }
    const resolvedDescription: string = normalizeField(description ?? "", MaxDescriptionLength);
    const resolvedSummary: string = normalizeField(summary ?? description ?? "", MaxSummaryLength);
    const resolvedPurpose: string = normalizeField(purpose ?? "", MaxPurposeLength);
    const base: NodeDescription = {
        description: resolvedDescription.length > 0 ? resolvedDescription : fallback.description,
        summary: resolvedSummary.length > 0 ? resolvedSummary : resolvedDescription.length > 0 ? resolvedDescription : fallback.summary,
        purpose: resolvedPurpose.length > 0 ? resolvedPurpose : fallback.purpose,
    };
    return withAnnotation(base, annotation);
};

/**
 * Derive description/summary/purpose for one directory from its direct
 * children.
 *
 * @param relative - Root-relative POSIX path.
 * @param children - Direct children in tree order.
 * @param annotation - Optional host override.
 * @param readme - Optional README text used for the purpose.
 * @returns The three descriptive fields.
 */
export const describeDirectory: (relative: string, children: readonly TreeNode[], annotation?: NodeAnnotation, readme?: string) => NodeDescription = (relative: string, children: readonly TreeNode[], annotation?: NodeAnnotation, readme?: string): NodeDescription => {
    const name: string = nameOfPath(relative);
    let files: number = 0;
    let directories: number = 0;
    const names: string[] = [];
    for (let index: number = 0; index < children.length; index += 1) {
        const child: TreeNode = children[index];
        if (child.type === "File") {
            files += 1;
            names.push(child.name);
        } else {
            directories += 1;
            names.push(`${child.name}/`);
        }
    }
    names.sort((left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0));
    const fileWord: string = files === 1 ? "file" : "files";
    const directoryWord: string = directories === 1 ? "directory" : "directories";
    const description: string = `Directory ${name} with ${files} ${fileWord} and ${directories} ${directoryWord}.`;
    const visible: string[] = names.slice(0, MaxSummaryChildren);
    const hidden: number = names.length - visible.length;
    const summary: string = names.length === 0 ? "Empty directory." : `Children: ${visible.join(", ")}${hidden > 0 ? ` (+${hidden} more)` : ""}.`;
    let purpose: string = "not declared";
    if (readme !== (void 0)) {
        const bounded: string = readme.length > MaxHeadBytes ? readme.slice(0, MaxHeadBytes) : readme;
        const front: FrontMatter = parseFrontMatter(bounded);
        purpose = front.purpose ?? firstParagraph(front.body) ?? firstMarkdownHeading(front.body) ?? "not declared";
    }
    const base: NodeDescription = {
        description: normalizeField(description, MaxDescriptionLength),
        summary: normalizeField(summary, MaxSummaryLength),
        purpose: normalizeField(purpose, MaxPurposeLength),
    };
    return withAnnotation(base, annotation);
};

/**
 * Look up an annotation by exact root-relative path. Parent-directory
 * annotations are not inherited: an override names exactly one node.
 *
 * @param annotations - Path-keyed override map.
 * @param relative - Exact root-relative path.
 * @returns The annotation when present.
 */
export const annotationFor: (annotations: Readonly<Record<string, NodeAnnotation>> | undefined, relative: string) => NodeAnnotation | undefined = (annotations: Readonly<Record<string, NodeAnnotation>> | undefined, relative: string): NodeAnnotation | undefined => {
    if (annotations === (void 0) || annotations === null) {
        return undefined;
    }
    if (!Object.prototype.hasOwnProperty.call(annotations, relative)) {
        return undefined;
    }
    return annotations[relative];
};
