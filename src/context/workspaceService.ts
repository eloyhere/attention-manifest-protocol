/**
 * One trusted host scope per service instance. Agent calls cannot register
 * Frames, supply snapshots, read arbitrary hashes or expand project scope.
 */
import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import { parseToolCall } from "../boundary/toolCall.ts";
import { BoundaryRejection } from "../error/boundaryRejection.ts";
import { parseShort, rawTextDigest } from "../fingerprint/index.ts";
import type { Frame } from "../frame/frame.ts";
import { HostCatalog } from "../discover/host.ts";
import { buildDiscoveryTree } from "../discover/tree.ts";
import type { ComponentKind, DiscoveryQuery, DiscoveryScope, HostComponent, ModuleKind } from "../discover/index.ts";
import { buildCatalog, deprecatedToolAliases, resolveToolName, ToolIds } from "../naming/index.ts";
import type { CatalogEntry, ToolCatalog } from "../naming/index.ts";
import { WorkspaceProtocol, WorkspaceProtocolVersion, WorkspaceServiceId, workspaceToolDefinitions, workspaceToolLeaves } from "../protocol/workspace.ts";
import type {
    WorkspaceDependencyEdge,
    WorkspaceDiffHunk,
    WorkspaceDiffNode,
    WorkspaceErrorCode,
    WorkspaceExportation,
    WorkspaceFileLink,
    WorkspaceImportation,
    WorkspaceImpacts,
    WorkspaceOutlineNode,
    WorkspaceProjectAction,
    WorkspaceProjectBrand,
    WorkspaceProjectDependency,
    WorkspaceProjectSummary,
    WorkspaceReactiveNode,
    WorkspaceReactiveProperty,
    WorkspaceResponse,
    WorkspaceToolDefinition,
} from "../protocol/workspace.ts";
import type { Receipt } from "../receipt/receipt.ts";
import { digestOf } from "../semantic/canonical.ts";
import { estimateTokens } from "./agentContext.ts";
import type { ContentStore } from "./contentStore.ts";
import type { Context, ContextSnapshot, ContextView } from "./lifecycle.ts";
import { WorkspaceIndex } from "./workspace.ts";
import type { WorkspaceEntity, WorkspaceQuery, WorkspaceRelation, WorkspaceRelationKind, WorkspaceSnapshot } from "./workspace.ts";
import { applyByteChanges, applyLineChanges, summarizeDiff } from "./workspaceDiff.ts";
import type { ByteChange, DiffSummary, LineChange } from "./workspaceDiff.ts";
import { WorkspaceDiffError } from "./workspaceDiff.ts";

export interface WorkspaceServiceLimits {
    maxFrames: number;
    maxContexts: number;
    maxViewTokens: number;
    maxReadChars: number;
    maxResponseChars: number;
    maxToolCalls: number;
    /**
     * Ceiling on the content a single write may produce. A line or byte splice
     * can grow a file well beyond the replacement text, so the check runs on
     * the resulting content, not on the argument alone.
     */
    maxWriteChars: number;
    /**
     * Per-list ceiling on the relative files reported by `exportation` and
     * `importation`. `total` and `truncated` keep the cut visible.
     */
    maxFileLinks: number;
    /**
     * Per-stream ceiling on captured runner output. Build logs are truncated
     * from the front so the failing tail is what survives.
     */
    maxRunOutputChars: number;
}

/**
 * Host-owned persistence port for `amp_tool_workspace_write`.
 *
 * The service never touches the file system: it validates Frame allocation,
 * the file target and compare-and-swap, then hands the host the exact project
 * URI and the complete new content. A host that cannot write answers with a
 * closed error code instead of throwing, so the adapter keeps the taxonomy.
 */
export interface WorkspaceWriteRequest {
    agentId: string;
    nodeId: string;
    uri: string;
    content: string;
    previousRevision: string;
}

/**
 * Persistence answer. `revision` is the host's content revision for the new
 * text, in the same convention as `WorkspaceSource.revision`, so the caller can
 * pass it back as `expectRevision` on the next write.
 */
export type WorkspaceWriteOutcome = { ok: true; revision: string; bytes?: number; } | { ok: false; code: WorkspaceErrorCode; };

/**
 * Discriminant guard.
 *
 * A type predicate is used instead of `if (!outcome.ok)` because the tools
 * TypeScript project runs with `strictNullChecks: false`, where truthiness of a
 * literal discriminant does not narrow the union.
 */
const writeRejected: (outcome: WorkspaceWriteOutcome) => outcome is { ok: false; code: WorkspaceErrorCode; } = (
    outcome: WorkspaceWriteOutcome,
): outcome is { ok: false; code: WorkspaceErrorCode; } => outcome.ok === false;

export interface WorkspaceWriter {
    write(request: WorkspaceWriteRequest): WorkspaceWriteOutcome;
}

/**
 * One executable action the project tool decided to request.
 *
 * `command` is produced by the service's brand table, never by the agent. The
 * runner is expected to apply its own allowlist, timeout and cwd confinement;
 * this port is the only place the workspace service can cause a process to run.
 */
export interface WorkspaceRunRequest {
    agentId: string;
    projectId: string;
    brand: string;
    action: Exclude<WorkspaceProjectAction, "detect">;
    command: string;
    cwd: string;
}

/**
 * Execution answer. A non-zero exit code is still a completed run; `ok: false`
 * means the host refused or could not start the process.
 */
export type WorkspaceRunOutcome =
    | { ok: true; exitCode: number; stdout?: string; stderr?: string; durationMs?: number; }
    | { ok: false; code: WorkspaceErrorCode; };

const runRejected: (outcome: WorkspaceRunOutcome) => outcome is { ok: false; code: WorkspaceErrorCode; } = (
    outcome: WorkspaceRunOutcome,
): outcome is { ok: false; code: WorkspaceErrorCode; } => outcome.ok === false;

export interface WorkspaceRunner {
    run(request: WorkspaceRunRequest): WorkspaceRunOutcome;
}

export interface WorkspaceServiceOptions {
    agentId: string;
    projectIds: readonly string[];
    snapshot: WorkspaceSnapshot;
    store: ContentStore;
    limits?: Partial<WorkspaceServiceLimits>;
    /**
     * Optional host write port. Without it the write tool still advertises its
     * schema but answers `write_unavailable`; `dryRun` keeps working because it
     * never reaches the host.
     */
    writer?: WorkspaceWriter;
    /**
     * Optional host execution port for the project tool. Without it detection
     * still works and `dryRun` returns the command, but a real action answers
     * `run_unavailable`. The port is synchronous because the protocol call is.
     */
    runner?: WorkspaceRunner;
    /**
     * Host-owned discovery metadata and components. Unauthorized projects and
     * components are filtered against `projectIds` before discovery sees them.
     */
    host?: HostCatalog;
}

interface Allocation {
    frame: Frame;
    state: "available" | "materialized" | "released" | "revoked";
    contextId?: string;
    remainingTokens: number;
}

interface Materialization {
    context: Context;
    allocation: Allocation;
    readable: Set<string>;
    response: WorkspaceResponse;
    requestedTokens: number;
}

/**
 * Locally accepted write that the host already persisted. Detail reads prefer
 * this text over the immutable snapshot detail, so a read after a write cannot
 * hand the model bytes the host replaced.
 */
interface AcceptedWrite {
    content: string;
    revision: string;
    bytes: number;
}

/**
 * Service-local annotation overlay written through `reactive_write`. It only
 * changes what this service reports; the host snapshot is not edited.
 */
interface ReactiveOverrides {
    summary?: string;
    label?: string;
    tags?: string[];
}

/**
 * Keys a reactive Proxy exposes. `toJSON` is not listed because it is the
 * serialization hook rather than tree data.
 */
const ReactiveKeys: readonly string[] = [
    "id",
    "kind",
    "label",
    "summary",
    "tags",
    "path",
    "structureKind",
    "startLine",
    "endLine",
    "revision",
    "childCount",
    "children",
];

/**
 * Shared node budget for one `reactive_read`; proxies and their `toJSON`
 * projections both draw from it so the wire form stays bounded.
 */
interface ReactiveBudget {
    nodes: number;
}

/**
 * One bounded detail page. `fields` holds the coordinates of the addressing
 * mode that produced the page; `offset`/`nextOffset` are always character
 * offsets, which makes them a universal continuation for line and byte pages.
 */
interface DetailPage {
    offset: number;
    text: string;
    nextOffset: number | null;
    fields: Record<string, number | string | null>;
}

type WriteMode = "node" | "lines" | "bytes";

interface WriteEdit {
    content: string;
    mode: WriteMode;
    fields: Record<string, number>;
}

const Defaults: WorkspaceServiceLimits = {
    maxFrames: 128,
    maxContexts: 32,
    maxViewTokens: 8000,
    maxReadChars: 8000,
    maxResponseChars: 131072,
    maxToolCalls: 1000,
    maxWriteChars: 1024 * 1024,
    maxFileLinks: 50,
    maxRunOutputChars: 16 * 1024,
};

const MaxReadLines: number = 2000;
const DefaultReadLines: number = 200;
const MaxPageBytes: number = 262144;
const LineFeed: number = 10;
const ContinuationMask: number = 0xc0;
const ContinuationByte: number = 0x80;

/**
 * 0-based UTF-16 offsets at which each line starts. An empty string has no
 * lines, and a trailing newline does not create a final empty line, which is
 * the same counting rule the filesystem read tool reports.
 */
const lineStartsOf: (text: string) => number[] = (text: string): number[] => {
    if (text.length === 0) {
        return [];
    }
    const starts: number[] = [0];
    for (let index: number = 0; index < text.length; index += 1) {
        if (text.charCodeAt(index) === LineFeed && index + 1 < text.length) {
            starts.push(index + 1);
        }
    }
    return starts;
};

/**
 * Largest line index whose start is at or before `position` (0-based).
 */
const lineIndexOf: (starts: readonly number[], position: number) => number = (starts: readonly number[], position: number): number => {
    let low: number = 0;
    let high: number = starts.length - 1;
    let answer: number = 0;
    while (low <= high) {
        const middle: number = (low + high) >> 1;
        if (starts[middle] <= position) {
            answer = middle;
            low = middle + 1;
        } else {
            high = middle - 1;
        }
    }
    return answer;
};

const isContinuationByte: (bytes: Uint8Array, index: number) => boolean = (bytes: Uint8Array, index: number): boolean =>
    index < bytes.length && (bytes[index] & ContinuationMask) === ContinuationByte;

/**
 * Decode the longest prefix of `bytes[start..end)` that ends on a character
 * boundary, and report the byte offset actually consumed.
 *
 * Shrinking costs at most the three continuation bytes of a UTF-8 character, so
 * a page never splits one and the decoder is never left holding invalid input.
 */
const decodePage: (bytes: Uint8Array, start: number, end: number) => { text: string; end: number; } = (bytes: Uint8Array, start: number, end: number): { text: string; end: number; } => {
    for (let adjusted: number = end; adjusted > start; adjusted -= 1) {
        try {
            return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(start, adjusted)), end: adjusted };
        } catch {
            continue;
        }
    }
    return { text: "", end: start };
};

/**
 * Page one detail body by characters (default), 1-based lines or UTF-8 bytes.
 *
 * Exactly one addressing mode may appear in a call; mixing them is rejected
 * instead of silently preferring one, because a caller that sent both offsets
 * has already made an addressing mistake.
 */
const readPage: (content: string, args: Record<string, unknown>, maxChars: number, remainingTokens: number) => DetailPage = (content: string, args: Record<string, unknown>, maxChars: number, remainingTokens: number): DetailPage => {
    const lines: boolean = Object.hasOwn(args, "startLine") || Object.hasOwn(args, "maxLines");
    const bytes: boolean = Object.hasOwn(args, "offsetBytes") || Object.hasOwn(args, "maxBytes");
    const chars: boolean = Object.hasOwn(args, "offset") || Object.hasOwn(args, "maxChars");
    if ((lines ? 1 : 0) + (bytes ? 1 : 0) + (chars ? 1 : 0) > 1) {
        fail("invalid_arguments");
    }
    const charBudget: number = Math.min(maxChars, remainingTokens * 4);
    if (bytes) {
        const encoded: Uint8Array = new TextEncoder().encode(content);
        const requested: number = (args.offsetBytes as number | undefined) ?? 0;
        if (requested > encoded.length) {
            fail("invalid_arguments");
        }
        let start: number = requested;
        while (start < encoded.length && isContinuationByte(encoded, start)) {
            start += 1;
        }
        const size: number = Math.min((args.maxBytes as number | undefined) ?? charBudget, MaxPageBytes, charBudget);
        const decoded: { text: string; end: number; } = decodePage(encoded, start, Math.min(encoded.length, start + size));
        let text: string = decoded.text;
        let consumed: number = decoded.end;
        /**
         * A byte budget smaller than one character still makes progress: the
         * whole first character is returned (at most four bytes) instead of an
         * empty page that would repeat forever.
         */
        if (text.length === 0 && start < encoded.length) {
            consumed = start + 1;
            while (consumed < encoded.length && isContinuationByte(encoded, consumed)) {
                consumed += 1;
            }
            text = new TextDecoder("utf-8", { fatal: true }).decode(encoded.subarray(start, consumed));
        }
        const charOffset: number = new TextDecoder("utf-8").decode(encoded.subarray(0, start)).length;
        return {
            offset: charOffset,
            text,
            nextOffset: consumed < encoded.length ? charOffset + text.length : null,
            fields: {
                offsetBytes: start,
                bytesRead: consumed - start,
                nextOffsetBytes: consumed < encoded.length ? consumed : null,
                totalBytes: encoded.length,
            },
        };
    }
    if (lines) {
        const starts: number[] = lineStartsOf(content);
        const startLine: number = (args.startLine as number | undefined) ?? 1;
        if (startLine > starts.length + 1) {
            fail("invalid_arguments");
        }
        const maxLines: number = Math.min((args.maxLines as number | undefined) ?? DefaultReadLines, MaxReadLines);
        const first: number = startLine - 1;
        let last: number = Math.min(starts.length, first + maxLines);
        while (last > first && (starts[last] ?? content.length) - (starts[first] ?? content.length) > charBudget) {
            last -= 1;
        }
        /**
         * A single line larger than the page budget is returned whole rather
         * than split: a split line has no line number to resume from, and the
         * caller can switch to byte mode when it really needs a smaller piece.
         */
        if (last === first && first < starts.length) {
            last = first + 1;
        }
        const startChar: number = starts[first] ?? content.length;
        const endChar: number = last < starts.length ? starts[last] : content.length;
        const text: string = content.slice(startChar, endChar);
        return {
            offset: startChar,
            text,
            nextOffset: endChar < content.length ? endChar : null,
            fields: {
                startLine,
                endLine: text.length === 0 ? null : lineIndexOf(starts, endChar - 1) + 1,
                nextStartLine: endChar < content.length ? lineIndexOf(starts, endChar) + 1 : null,
                totalLines: starts.length,
            },
        };
    }
    const offset: number = (args.offset as number | undefined) ?? 0;
    if (offset > content.length) {
        fail("invalid_arguments");
    }
    const size: number = Math.min((args.maxChars as number | undefined) ?? maxChars, maxChars, remainingTokens * 4);
    const text: string = content.slice(offset, offset + size);
    return { offset, text, nextOffset: offset + text.length < content.length ? offset + text.length : null, fields: {} };
};

/**
 * Apply a whole-node, line-range or byte-range replacement.
 *
 * Line mode replaces complete lines and keeps the file's line-terminator shape:
 * a replacement that lost its final terminator gets the replaced span's own
 * terminator back, while an empty replacement deletes the lines and their
 * separator. Byte mode splices UTF-8 bytes and refuses an offset that falls
 * inside a character, because the result is still decoded as text.
 */
const applyWrite: (current: string, args: Record<string, unknown>) => WriteEdit = (current: string, args: Record<string, unknown>): WriteEdit => {
    const lines: boolean = Object.hasOwn(args, "startLine") || Object.hasOwn(args, "endLine");
    const bytes: boolean = Object.hasOwn(args, "offsetBytes") || Object.hasOwn(args, "endBytes");
    if (lines && bytes) {
        fail("invalid_arguments");
    }
    const replacement: string = args.content as string;
    if (!lines && !bytes) {
        return { content: replacement, mode: "node", fields: {} };
    }
    if (lines) {
        const startLine: number | undefined = args.startLine as number | undefined;
        const endLine: number | undefined = args.endLine as number | undefined;
        if (startLine === (void 0) || endLine === (void 0) || startLine < 1 || endLine < startLine) {
            fail("invalid_arguments");
        }
        const starts: number[] = lineStartsOf(current);
        if (startLine > starts.length || endLine > starts.length) {
            fail("invalid_arguments");
        }
        const startChar: number = starts[startLine - 1];
        const endChar: number = endLine < starts.length ? starts[endLine] : current.length;
        const span: string = current.slice(startChar, endChar);
        const terminator: string = span.endsWith("\r\n") ? "\r\n" : span.endsWith("\n") ? "\n" : "";
        const inserted: string =
            replacement.length === 0 || terminator.length === 0 || replacement.endsWith("\n") ? replacement : `${replacement}${terminator}`;
        return { content: `${current.slice(0, startChar)}${inserted}${current.slice(endChar)}`, mode: "lines", fields: { startLine, endLine } };
    }
    const offsetBytes: number | undefined = args.offsetBytes as number | undefined;
    const endBytes: number | undefined = args.endBytes as number | undefined;
    if (offsetBytes === (void 0) || endBytes === (void 0) || offsetBytes < 0 || endBytes < offsetBytes) {
        fail("invalid_arguments");
    }
    const encoded: Uint8Array = new TextEncoder().encode(current);
    if (endBytes > encoded.length || isContinuationByte(encoded, offsetBytes) || isContinuationByte(encoded, endBytes)) {
        fail("invalid_arguments");
    }
    const insert: Uint8Array = new TextEncoder().encode(replacement);
    const spliced: Uint8Array = new Uint8Array(offsetBytes + insert.length + (encoded.length - endBytes));
    spliced.set(encoded.subarray(0, offsetBytes), 0);
    spliced.set(insert, offsetBytes);
    spliced.set(encoded.subarray(endBytes), offsetBytes + insert.length);
    try {
        return { content: new TextDecoder("utf-8", { fatal: true }).decode(spliced), mode: "bytes", fields: { offsetBytes, endBytes } };
    } catch {
        return fail("invalid_arguments");
    }
};

/**
 * Commands the project tool may request per brand. An absent action means the
 * brand has no conventional command for it, and the tool reports
 * `unsupported_action` instead of inventing one.
 */
type BrandCommands = Partial<Record<Exclude<WorkspaceProjectAction, "detect">, string>>;

/**
 * Brand evidence. A manifest basename (or suffix) proves a toolchain exists;
 * optional `evidence` basenames disambiguate the npm family, where several
 * package managers share one `package.json`.
 */
interface BrandSpec {
    brand: string;
    language: string;
    manifests: readonly string[];
    suffixes?: readonly string[];
    evidence?: readonly string[];
    commands: BrandCommands;
}

/**
 * Detection order is specificity order: lockfile-specific package managers
 * before plain npm, real build systems before the auxiliary `Makefile`, so the
 * first match is the primary brand and later matches stay in `detected`.
 */
const ProjectBrands: readonly BrandSpec[] = [
    {
        brand: "pnpm",
        language: "typescript/javascript",
        manifests: ["package.json"],
        evidence: ["pnpm-lock.yaml", "pnpm-workspace.yaml"],
        commands: { build: "pnpm run build", compile: "pnpm run compile", run: "pnpm start", test: "pnpm test" },
    },
    {
        brand: "yarn",
        language: "typescript/javascript",
        manifests: ["package.json"],
        evidence: ["yarn.lock"],
        commands: { build: "yarn build", compile: "yarn compile", run: "yarn start", test: "yarn test" },
    },
    {
        brand: "bun",
        language: "typescript/javascript",
        manifests: ["package.json"],
        evidence: ["bun.lockb", "bun.lock"],
        commands: { build: "bun run build", compile: "bun run compile", run: "bun start", test: "bun test" },
    },
    {
        brand: "npm",
        language: "typescript/javascript",
        manifests: ["package.json"],
        commands: { build: "npm run build", compile: "npm run compile", run: "npm start", test: "npm test" },
    },
    {
        brand: "maven",
        language: "java",
        manifests: ["pom.xml"],
        commands: { build: "mvn package -DskipTests", compile: "mvn compile", run: "mvn exec:java", test: "mvn test" },
    },
    {
        brand: "gradle",
        language: "java/kotlin",
        manifests: ["build.gradle", "build.gradle.kts"],
        commands: { build: "gradle build", compile: "gradle compileJava", run: "gradle run", test: "gradle test" },
    },
    {
        brand: "cmake",
        language: "c/c++",
        manifests: ["CMakeLists.txt"],
        commands: { build: "cmake --build build --config Release", compile: "cmake --build build", test: "ctest --test-dir build --output-on-failure" },
    },
    {
        brand: "cargo",
        language: "rust",
        manifests: ["Cargo.toml"],
        commands: { build: "cargo build", compile: "cargo check", run: "cargo run", test: "cargo test" },
    },
    {
        brand: "go",
        language: "go",
        manifests: ["go.mod"],
        commands: { build: "go build ./...", compile: "go vet ./...", run: "go run .", test: "go test ./..." },
    },
    {
        brand: "python",
        language: "python",
        manifests: ["pyproject.toml"],
        commands: { build: "python -m build", compile: "python -m compileall .", test: "python -m pytest -q" },
    },
    {
        brand: "setuptools",
        language: "python",
        manifests: ["setup.py"],
        commands: { build: "python -m build", test: "python -m pytest -q" },
    },
    {
        brand: "composer",
        language: "php",
        manifests: ["composer.json"],
        commands: { build: "composer install --no-interaction", test: "composer test" },
    },
    {
        brand: "dotnet",
        language: "c#/f#",
        manifests: [],
        suffixes: [".sln", ".csproj", ".fsproj", ".vbproj"],
        commands: { build: "dotnet build", compile: "dotnet build", run: "dotnet run", test: "dotnet test" },
    },
    {
        brand: "bundler",
        language: "ruby",
        manifests: ["Gemfile"],
        commands: { build: "bundle install", test: "bundle exec rake test" },
    },
    {
        brand: "swift",
        language: "swift",
        manifests: ["Package.swift"],
        commands: { build: "swift build", compile: "swift build", run: "swift run", test: "swift test" },
    },
    {
        brand: "sbt",
        language: "scala",
        manifests: ["build.sbt"],
        commands: { build: "sbt package", compile: "sbt compile", run: "sbt run", test: "sbt test" },
    },
    {
        brand: "make",
        language: "c/c++",
        manifests: ["Makefile"],
        commands: { build: "make", compile: "make all", run: "make run", test: "make test" },
    },
];

const ProjectActionOrder: readonly Exclude<WorkspaceProjectAction, "detect">[] = ["build", "compile", "run", "test"];

const actionsOf: (commands: BrandCommands) => WorkspaceProjectAction[] = (commands: BrandCommands): WorkspaceProjectAction[] =>
    ProjectActionOrder.filter((action): boolean => commands[action] !== (void 0));

/**
 * Prefer the checked-in wrapper when one exists: a Gradle project that ships
 * `gradlew` is meant to be built through it, not through a host-global Gradle.
 */
const commandsOf: (spec: BrandSpec, wrapper: boolean) => BrandCommands = (spec: BrandSpec, wrapper: boolean): BrandCommands =>
    Object.fromEntries(
        (Object.entries(spec.commands) as Array<[Exclude<WorkspaceProjectAction, "detect">, string]>).map(
            ([action, command]): [Exclude<WorkspaceProjectAction, "detect">, string] => [
                action,
                wrapper && spec.brand === "gradle" ? command.replace(/^gradle\b/, "./gradlew") : command,
            ],
        ),
    ) as BrandCommands;

interface DetectedBrand {
    brand: string;
    language: string;
    manifest: WorkspaceEntity;
    commands: BrandCommands;
}

/**
 * Detect every brand evidenced by one project's files.
 *
 * Inputs are file entities only; the scan is offline and never opens a
 * manifest, so a `pom.xml` that does not parse still proves a Maven layout.
 */
const detectBrands: (files: readonly WorkspaceEntity[]) => DetectedBrand[] = (files: readonly WorkspaceEntity[]): DetectedBrand[] => {
    const sorted: WorkspaceEntity[] = [...files].sort((left: WorkspaceEntity, right: WorkspaceEntity): number =>
        left.source.uri < right.source.uri ? -1 : left.source.uri > right.source.uri ? 1 : 0,
    );
    const names: Set<string> = new Set<string>(sorted.map((file: WorkspaceEntity): string => posix.basename(file.source.uri)));
    const detected: DetectedBrand[] = [];
    ProjectBrands.forEach((spec: BrandSpec): void => {
        const manifest: WorkspaceEntity | undefined =
            spec.suffixes === (void 0)
                ? sorted.find((file: WorkspaceEntity): boolean => spec.manifests.includes(posix.basename(file.source.uri)))
                : sorted.find((file: WorkspaceEntity): boolean =>
                      spec.suffixes!.some((suffix: string): boolean => posix.basename(file.source.uri).toLowerCase().endsWith(suffix)),
                  );
        if (manifest === (void 0)) {
            return;
        }
        if (spec.evidence !== (void 0) && !spec.evidence.some((name: string): boolean => names.has(name))) {
            return;
        }
        detected.push({ brand: spec.brand, language: spec.language, manifest, commands: commandsOf(spec, names.has("gradlew")) });
    });
    return detected;
};

/**
 * Keep the failing tail of runner output. A build log's useful part is at the
 * end, and the response budget cannot grow with the build.
 */
const clipOutput: (text: string | undefined, max: number) => { text: string; truncated: boolean; } = (text: string | undefined, max: number): { text: string; truncated: boolean; } =>
    text === (void 0) ? { text: "", truncated: false } : text.length <= max ? { text, truncated: false } : { text: text.slice(text.length - max), truncated: true };

/**
 * Structural order: directories before files, then label, then id.
 */
const byStructureOrder: (left: WorkspaceEntity, right: WorkspaceEntity) => number = (left: WorkspaceEntity, right: WorkspaceEntity): number =>
    (left.kind === right.kind ? 0 : left.kind === "directory" ? -1 : 1) ||
    (left.label < right.label ? -1 : left.label > right.label ? 1 : 0) ||
    (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);

/**
 * Outline order: start line first so a file's symbols read top to bottom.
 */
const bySourceOrder: (left: WorkspaceEntity, right: WorkspaceEntity) => number = (left: WorkspaceEntity, right: WorkspaceEntity): number =>
    (left.source.startLine ?? 0) - (right.source.startLine ?? 0) ||
    (left.label < right.label ? -1 : left.label > right.label ? 1 : 0) ||
    (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);

/**
 * Shape the validated tool arguments into the diff helper's input. The JSON
 * Schema already enforced number/string types, so these casts add no runtime
 * trust: the helper re-validates every range.
 */
const asLineChange: (item: Record<string, unknown>) => LineChange = (item: Record<string, unknown>): LineChange => ({
    startLine: item.startLine as number,
    endLine: item.endLine as number,
    content: item.content as string,
});

const asByteChange: (item: Record<string, unknown>) => ByteChange = (item: Record<string, unknown>): ByteChange => ({
    offsetBytes: item.offsetBytes as number,
    endBytes: item.endBytes as number,
    content: item.content as string,
});

class WorkspaceServiceError extends Error {
    readonly code: WorkspaceErrorCode;

    constructor(code: WorkspaceErrorCode) {
        super(code);
        this.code = code;
    }
}

const fail: (code: WorkspaceErrorCode) => never = (code: WorkspaceErrorCode): never => {
    throw new WorkspaceServiceError(code);
};

export class WorkspaceAgentService {
    private readonly agentId: string;
    private readonly index: WorkspaceIndex;
    private readonly limits: WorkspaceServiceLimits;
    private readonly frames: Map<string, Allocation> = new Map();
    private readonly contexts: Map<string, Materialization> = new Map();
    private readonly retired: Map<string, Materialization> = new Map();
    private readonly roots: WorkspaceEntity[];
    private readonly definitions: WorkspaceToolDefinition[] = workspaceToolDefinitions();
    private readonly host: HostCatalog;
    private readonly projectIds: Set<string>;
    private readonly store: ContentStore;
    private readonly writer?: WorkspaceWriter;
    private readonly runner?: WorkspaceRunner;
    /**
     * Files the host already persisted through this service. The snapshot stays
     * immutable, so this overlay is what keeps a read after a write honest.
     */
    private readonly writes: Map<string, AcceptedWrite> = new Map();
    /**
     * Reactive overlay and child-index cache. `reactive_write` bumps
     * `cacheVersion` and drops the node plus its ancestors, so the next
     * `reactive_read` recomputes exactly the affected subtree.
     */
    private readonly reactiveOverrides: Map<string, ReactiveOverrides> = new Map();
    private readonly reactiveCache: Map<string, WorkspaceEntity[]> = new Map();
    private cacheVersion: number = 0;
    private cachedCatalog: ToolCatalog | undefined;
    private calls: number = 0;

    constructor(options: WorkspaceServiceOptions) {
        if (!options.agentId || !Array.isArray(options.projectIds)) {
            throw new Error("workspace service requires a host agent and explicit project scope");
        }
        this.agentId = options.agentId;
        this.host = options.host ?? new HostCatalog();
        this.projectIds = new Set<string>(options.projectIds);
        this.writer = options.writer;
        this.runner = options.runner;
        this.limits = { ...Defaults, ...options.limits };
        Object.entries(this.limits).forEach(([key, value]: [string, number]): void => {
            if (!Number.isSafeInteger(value) || value < 1 || value > Defaults[key as keyof WorkspaceServiceLimits]) {
                throw new Error(`invalid workspace service limit ${key}`);
            }
        });
        const projects: Set<string> = new Set(options.projectIds);
        projects.forEach((id: string): void => {
            if (!options.snapshot.entities.some((entity: WorkspaceEntity): boolean => entity.id === id && entity.kind === "project")) {
                throw new Error("unknown authorized project");
            }
        });
        const entities: WorkspaceEntity[] = options.snapshot.entities.filter((entity: WorkspaceEntity): boolean => projects.has(entity.projectId));
        const ids: Set<string> = new Set(entities.map((entity: WorkspaceEntity): string => entity.id));
        const store: ContentStore = options.store;
        const verifiedStore: ContentStore = {
            put: (): never => fail("internal_error"),
            get: (ref: string): string | undefined => {
                try {
                    /**
                     * `parseShort` is the one definition of a ref's shape, and
                     * the algorithm check keeps a future `sha512:` ref from being
                     * accepted as if it were this store's `sha256:` namespace.
                     */
                    const parsed: ReturnType<typeof parseShort> = parseShort(ref);
                    if (parsed === (void 0) || parsed.algorithm !== "sha256") {
                        return fail("integrity_failure");
                    }
                    const content: string | undefined = store.get(ref);
                    if (content !== (void 0) && rawTextDigest(content) !== ref) {
                        return fail("integrity_failure");
                    }
                    return content;
                } catch {
                    return fail("integrity_failure");
                }
            },
        };
        this.store = verifiedStore;
        this.index = new WorkspaceIndex(
            {
                version: options.snapshot.version,
                revision: options.snapshot.revision,
                entities,
                relations: options.snapshot.relations.filter((edge): boolean => ids.has(edge.from) && ids.has(edge.to)),
                diagnostics: [],
            },
            verifiedStore,
        );
        this.roots = this.index.snapshot().entities.filter((entity: WorkspaceEntity): boolean => entity.kind === "project");
    }

    /**
     * Host-only registration. Frames bind to this snapshot revision explicitly;
     * their digest remains the AMP Frame digest, not a workspace revision field.
     */
    registerFrame(frame: Frame, revision: string): void {
        if (revision !== this.index.revision) {
            fail("revision_mismatch");
        }
        const tokens: number | undefined = frame.budget?.allocated?.tokens;
        const spent: number = frame.budget?.spent?.tokens ?? 0;
        if (
            frame.amp !== "0.1" ||
            frame.kind !== "frame" ||
            !frame.id ||
            frame.agent !== this.agentId ||
            !Array.isArray(frame.slots) ||
            frame.slots.length > 9 ||
            !Number.isSafeInteger(tokens) ||
            tokens! < 1 ||
            !Number.isSafeInteger(spent) ||
            spent < 0 ||
            spent > tokens! ||
            frame.slots.some(
                (slot): boolean =>
                    !slot.target?.id ||
                    !this.index.entity(slot.target.id) ||
                    !["active", "released", "evicted", "done"].includes(slot.state) ||
                    !slot.why?.trim(),
            )
        ) {
            fail("invalid_arguments");
        }
        if (this.frames.has(frame.id) || this.frames.size >= this.limits.maxFrames) {
            fail("capacity_exceeded");
        }
        this.frames.set(frame.id, { frame: structuredClone(frame), state: "available", remainingTokens: tokens! - spent });
    }

    /**
     * Revocation destroys any live handle and cannot be reversed by an agent.
     */
    revokeFrame(frameId: string): void {
        const allocation: Allocation | undefined = this.frames.get(frameId);
        if (allocation === (void 0)) {
            fail("frame_unavailable");
        }
        if (allocation.contextId !== (void 0)) {
            const item: Materialization | undefined = this.contexts.get(allocation.contextId);
            if (item !== (void 0)) {
                this.retired.set(allocation.contextId, item);
            }
            this.contexts.delete(allocation.contextId);
        }
        allocation.state = "revoked";
    }

    /**
     * Only the host can attest actual outcomes and settle an action Receipt.
     * Settlement removes the model's detail handle; release alone is not settlement.
     */
    settle(contextId: string, receipt: Receipt): ContextSnapshot {
        const item: Materialization | undefined = this.contexts.get(contextId) ?? this.retired.get(contextId);
        if (item === (void 0)) {
            fail("not_available");
        }
        item.context.settle(receipt);
        item.context.compact();
        item.context.archive();
        const snapshot: ContextSnapshot = item.context.snapshot();
        if (item.allocation.state !== "revoked") {
            item.allocation.state = "released";
        }
        this.contexts.delete(contextId);
        this.retired.delete(contextId);
        return snapshot;
    }

    /**
     * Host reconciliation survives agent release/revocation within this process.
     * Estimated text tokens are separate from actual model usage in Receipts.
     */
    pendingSettlements(): Array<{ contextId: string; frameId: string; estimatedTokens: number; }> {
        return [...this.contexts.entries(), ...this.retired.entries()].map(
            ([contextId, item]: [string, Materialization]): { contextId: string; frameId: string; estimatedTokens: number; } => ({
                contextId,
                frameId: item.allocation.frame.id,
                estimatedTokens:
                    item.allocation.frame.budget.allocated.tokens! - (item.allocation.frame.budget.spent.tokens ?? 0) - item.allocation.remainingTokens,
            }),
        );
    }

    tools(): WorkspaceToolDefinition[] {
        return structuredClone(this.definitions);
    }

    /**
     * Summarize the advertised definitions as a catalog.
     *
     * The digest binds description, schema and risk, so a host that pinned an
     * approved catalog can detect a descriptor swapped after approval. The
     * result is memoized because the definitions are immutable for the lifetime
     * of a service instance; rebuilding would compute the same digests again.
     */
    catalog(): ToolCatalog {
        if (this.cachedCatalog !== (void 0)) {
            return this.cachedCatalog;
        }
        const entries: CatalogEntry[] = this.definitions.map((tool: WorkspaceToolDefinition): CatalogEntry => ({
            id: tool.name,
            digest: digestOf({ description: tool.description, inputSchema: tool.inputSchema, risk: tool.risk }),
            risk: tool.risk,
        }));
        this.cachedCatalog = buildCatalog(entries, { version: "1.0.0", ttlMs: 0, cacheScope: "private" });
        return this.cachedCatalog;
    }

    call(name: string, raw: unknown): WorkspaceResponse {
        try {
            const canonical: string | undefined = resolveToolName(name);
            if (this.calls >= this.limits.maxToolCalls) {
                return fail("budget_exhausted");
            }
            this.calls += 1;
            if (canonical === (void 0)) {
                return fail("unknown_tool");
            }
            const tool: WorkspaceToolDefinition | undefined = this.definitions.find((item: WorkspaceToolDefinition): boolean => item.name === canonical);
            if (tool === (void 0)) {
                return fail("unknown_tool");
            }
            const args: Record<string, unknown> = parseToolCall(tool, raw).args;
            if (canonical !== ToolIds.workspaceCapabilities && args.revision !== this.index.revision) {
                return fail("revision_mismatch");
            }
            return this.dispatch(canonical, args);
        } catch (error: unknown) {
            const code: WorkspaceErrorCode =
                error instanceof WorkspaceServiceError ? error.code : error instanceof BoundaryRejection ? "invalid_arguments" : "internal_error";
            return { protocol: WorkspaceProtocol, version: WorkspaceProtocolVersion, revision: this.index.revision, ok: false, error: { code, message: code } };
        }
    }

    private reply(data: Record<string, unknown>): WorkspaceResponse {
        const result: WorkspaceResponse = { protocol: WorkspaceProtocol, version: WorkspaceProtocolVersion, revision: this.index.revision, ok: true, data };
        if (JSON.stringify(result).length > this.limits.maxResponseChars) {
            fail("response_too_large");
        }
        return result;
    }

    private requireEntity(id: string): WorkspaceEntity {
        return this.index.entity(id) ?? fail("not_available");
    }

    private dispatch(name: string, args: Record<string, unknown>): WorkspaceResponse {
        const leaf: string = workspaceToolLeaves.get(name) ?? fail("unknown_tool");
        switch (leaf) {
            case "capabilities": {
                const catalog: ToolCatalog = this.catalog();
                return this.reply({
                    agentId: this.agentId,
                    projectIds: this.roots.map((entity: WorkspaceEntity): string => entity.id),
                    frames: [...this.frames.values()]
                        .filter((item: Allocation): boolean => item.state === "available" || item.state === "materialized")
                        .map((item: Allocation): Record<string, unknown> => ({ frameId: item.frame.id, state: item.state, remainingTokens: item.remainingTokens })),
                    limits: { ...this.limits },
                    remainingToolCalls: this.limits.maxToolCalls - this.calls,
                    tools: this.definitions.map((tool: WorkspaceToolDefinition): string => tool.name),
                    catalog: { version: catalog.version, digest: catalog.digest, sortedBy: catalog.sortedBy, ttlMs: catalog.ttlMs },
                    deprecatedAliases: [...deprecatedToolAliases],
                    tokenAccounting: "character-estimate; summary text and detail pages only; discovery and JSON envelope excluded",
                });
            }
            case "tree": {
                const parentId: string | undefined = args.parentId as string | undefined;
                if (parentId !== (void 0)) {
                    this.requireEntity(parentId);
                }
                const all: WorkspaceEntity[] = parentId === (void 0) ? this.roots : this.index.children(parentId);
                const offset: number = (args.offset as number | undefined) ?? 0;
                const end: number = Math.min(all.length, offset + ((args.limit as number | undefined) ?? 32));
                return this.reply({
                    items: all.slice(offset, end).map((entity: WorkspaceEntity): Record<string, unknown> => ({
                        id: entity.id,
                        kind: entity.kind,
                        label: entity.label,
                        parentId: entity.parentId,
                        structureKind: entity.structureKind,
                        source: entity.source,
                        hasDetail: entity.detailRef !== (void 0),
                        summaryState: this.index.summaryState(entity.id),
                    })),
                    total: all.length,
                    nextOffset: end < all.length ? end : null,
                });
            }
            case "query": {
                const query: Record<string, unknown> = { ...args };
                delete query.revision;
                const result: ReturnType<WorkspaceIndex["query"]> = this.index.query(query as WorkspaceQuery);
                return this.reply({ ...result });
            }
            case "relations": {
                this.requireEntity(args.nodeId as string);
                const all: ReturnType<WorkspaceIndex["relations"]> = this.index.relations(
                    args.nodeId as string,
                    args.direction as "incoming" | "outgoing",
                    args.relationKind as WorkspaceRelationKind | undefined,
                );
                const offset: number = (args.offset as number | undefined) ?? 0;
                const end: number = Math.min(all.length, offset + ((args.limit as number | undefined) ?? 32));
                return this.reply({ items: all.slice(offset, end), total: all.length, nextOffset: end < all.length ? end : null });
            }
            case "discover": {
                return this.discover(args);
            }
            case "project": {
                return this.project(args);
            }
            case "outline": {
                return this.outline(args);
            }
            case "dependency": {
                return this.dependency(args);
            }
            case "reactive_read": {
                return this.reactiveRead(args);
            }
            case "reactive_write": {
                return this.reactiveWrite(args);
            }
            case "diff_read": {
                return this.diffRead(args);
            }
            case "materialize": {
                return this.materialize(args.frameId as string, args.budgetTokens as number);
            }
            default: {
                break;
            }
        }
        const item: Materialization | undefined = this.contexts.get(args.contextId as string);
        if (item === (void 0)) {
            return fail("not_available");
        }
        switch (leaf) {
            case "release": {
                const response: WorkspaceResponse = this.reply({
                    released: true,
                    frameId: item.allocation.frame.id,
                    remainingTokens: item.allocation.remainingTokens,
                });
                this.contexts.delete(args.contextId as string);
                this.retired.set(args.contextId as string, item);
                item.allocation.state = "released";
                return response;
            }
            case "read": {
                return this.read(item, args);
            }
            case "write": {
                return this.write(item, args);
            }
            case "diff_write": {
                return this.diffWrite(item, args);
            }
            default: {
                return fail("unknown_tool");
            }
        }
    }

    /**
     * Agent-callable project discovery. The result is a structural tree over
     * only the authorized snapshot plus host components that belong to the
     * authorized project scope. Content matches are bounded snippets, never a
     * replacement for a Frame-allocated detail read.
     */
    private discover(args: Record<string, unknown>): WorkspaceResponse {
        const query: DiscoveryQuery = {
            ...(args.text === (void 0) ? {} : { text: args.text as string }),
            ...(args.scope === (void 0) ? {} : { scope: args.scope as DiscoveryScope }),
            ...(args.moduleKind === (void 0) ? {} : { moduleKind: args.moduleKind as ModuleKind }),
            ...(args.componentKind === (void 0) ? {} : { componentKind: args.componentKind as ComponentKind }),
            ...(args.extension === (void 0) ? {} : { extension: args.extension as string }),
            ...(args.pathPrefix === (void 0) ? {} : { pathPrefix: args.pathPrefix as string }),
            ...(args.content === (void 0) ? {} : { content: args.content as boolean }),
            ...(args.maxDepth === (void 0) ? {} : { maxDepth: args.maxDepth as number }),
            ...(args.limit === (void 0) ? {} : { limit: args.limit as number }),
        };
        const projects = this.host
            .projects()
            .filter((project) => this.projectIds.has(project.id) || (project.rootId !== (void 0) && this.projectIds.has(project.rootId)));
        const components = this.host.components().filter((component) => component.projectId === (void 0) || this.projectIds.has(component.projectId));
        const tree = buildDiscoveryTree({
            revision: this.index.revision,
            entities: this.index.snapshot().entities,
            projects,
            components,
            builtIn: this.builtInComponents(),
            query,
            contentOf: (entity: WorkspaceEntity): string | undefined => {
                if (entity.detailRef === (void 0)) {
                    return undefined;
                }
                const content: string | undefined = this.store.get(entity.detailRef);
                return content === (void 0) ? undefined : content.slice(0, 65_536);
            },
        });
        return this.reply({ ...tree });
    }

    /**
     * Project scope: one explicitly named project or every authorized root.
     */
    private projectScope(projectId: string | undefined): WorkspaceEntity[] {
        if (projectId === (void 0)) {
            return this.roots;
        }
        const project: WorkspaceEntity = this.requireEntity(projectId);
        if (project.kind !== "project") {
            return fail("invalid_arguments");
        }
        return [project];
    }

    private projectSummary(project: WorkspaceEntity, files: readonly WorkspaceEntity[]): WorkspaceProjectSummary {
        const detected: DetectedBrand[] = detectBrands(files.filter((file: WorkspaceEntity): boolean => file.projectId === project.id));
        const primary: DetectedBrand | undefined = detected[0];
        const toBrand: (item: DetectedBrand) => WorkspaceProjectBrand = (item: DetectedBrand): WorkspaceProjectBrand => ({
            brand: item.brand,
            language: item.language,
            manifest: { id: item.manifest.id, path: item.manifest.source.uri },
            actions: actionsOf(item.commands),
            commands: item.commands,
        });
        return {
            projectId: project.id,
            label: project.label,
            cwd: primary === (void 0) ? "." : posix.dirname(primary.manifest.source.uri),
            brand: primary === (void 0) ? "unknown" : primary.brand,
            language: primary === (void 0) ? "unknown" : primary.language,
            manifest: primary === (void 0) ? null : { id: primary.manifest.id, path: primary.manifest.source.uri },
            actions: primary === (void 0) ? [] : actionsOf(primary.commands),
            commands: primary === (void 0) ? {} : primary.commands,
            detected: detected.map(toBrand),
        };
    }

    /**
     * Brand detection plus host-delegated build/compile/run/test.
     *
     * A non-detect action requires an unambiguous project, picks one command
     * from the brand table, and hands it to the runner port. The agent never
     * supplies command text, and the host can refuse with a closed error code.
     */
    private project(args: Record<string, unknown>): WorkspaceResponse {
        const projects: WorkspaceEntity[] = this.projectScope(args.projectId as string | undefined);
        const files: WorkspaceEntity[] = this.index.snapshot().entities.filter((entity: WorkspaceEntity): boolean => entity.kind === "file");
        const summaries: WorkspaceProjectSummary[] = projects.map((project: WorkspaceEntity): WorkspaceProjectSummary => this.projectSummary(project, files));
        const action: WorkspaceProjectAction = (args.action as WorkspaceProjectAction | undefined) ?? "detect";
        if (action === "detect") {
            return this.reply({ action, projects: summaries, total: summaries.length });
        }
        if (summaries.length !== 1) {
            return fail("invalid_arguments");
        }
        const summary: WorkspaceProjectSummary = summaries[0];
        const requestedBrand: string | undefined = args.brand as string | undefined;
        /**
         * A mixed repository can detect several brands. Without an explicit
         * `brand`, prefer the first detected brand that actually defines the
         * requested action, so `run` does not fail merely because the most
         * specific manifest has no run target. With `brand`, the choice is
         * exactly that brand and a missing action is `unsupported_action`.
         */
        const candidates: WorkspaceProjectBrand[] = summary.detected.filter(
            (brand: WorkspaceProjectBrand): boolean => requestedBrand === (void 0) || brand.brand === requestedBrand,
        );
        const chosen: WorkspaceProjectBrand | undefined =
            candidates.find((brand: WorkspaceProjectBrand): boolean => brand.commands[action] !== (void 0)) ?? candidates[0];
        if (chosen === (void 0)) {
            return fail("invalid_arguments");
        }
        const command: string | undefined = chosen.commands[action];
        if (command === (void 0)) {
            return fail("unsupported_action");
        }
        const cwd: string = posix.dirname(chosen.manifest.path);
        const payload: Record<string, unknown> = { projectId: summary.projectId, brand: chosen.brand, action, command, cwd };
        if (args.dryRun === true) {
            return this.reply({ ...payload, dryRun: true });
        }
        if (this.runner === (void 0)) {
            return fail("run_unavailable");
        }
        const outcome: WorkspaceRunOutcome = this.runner.run({
            agentId: this.agentId,
            projectId: summary.projectId,
            brand: chosen.brand,
            action,
            command,
            cwd,
        });
        if (runRejected(outcome)) {
            return fail(outcome.code);
        }
        /**
         * The port is host code, so validate its shape before it reaches the
         * reply: a missing exit code or a non-string stream would otherwise
         * produce a malformed response instead of a closed `internal_error`.
         */
        if (
            !Number.isSafeInteger(outcome.exitCode) ||
            (outcome.stdout !== (void 0) && typeof(outcome.stdout) !== "string") ||
            (outcome.stderr !== (void 0) && typeof(outcome.stderr) !== "string") ||
            (outcome.durationMs !== (void 0) && (!Number.isFinite(outcome.durationMs) || outcome.durationMs < 0))
        ) {
            return fail("internal_error");
        }
        const stdout: { text: string; truncated: boolean; } = clipOutput(outcome.stdout, this.limits.maxRunOutputChars);
        const stderr: { text: string; truncated: boolean; } = clipOutput(outcome.stderr, this.limits.maxRunOutputChars);
        return this.reply({
            ...payload,
            dryRun: false,
            exitCode: outcome.exitCode,
            ...(outcome.durationMs === (void 0) ? {} : { durationMs: outcome.durationMs }),
            stdout: stdout.text,
            stderr: stderr.text,
            stdoutTruncated: stdout.truncated,
            stderrTruncated: stderr.truncated,
        });
    }

    /**
     * Cascading outline: project → directory → file → symbol/knowledge.
     *
     * Depth and node count are bounded; `childCount` is computed before the
     * node limit is applied so a truncated node stays distinguishable from a
     * leaf. File bodies are never read here.
     */
    private outline(args: Record<string, unknown>): WorkspaceResponse {
        const projects: WorkspaceEntity[] = this.projectScope(args.projectId as string | undefined);
        const limit: number = Math.min((args.limit as number | undefined) ?? 500, 2000);
        const maxDepth: number = Math.min((args.maxDepth as number | undefined) ?? 8, 12);
        const includeSymbols: boolean = args.includeSymbols !== false;
        const pathPrefix: string | undefined = args.pathPrefix as string | undefined;
        const extension: string | undefined = (args.extension as string | undefined)?.replace(/^\./, "").toLowerCase();
        let emitted: number = 0;
        let truncated: boolean = false;
        const fileMatches: (file: WorkspaceEntity) => boolean = (file: WorkspaceEntity): boolean => {
            if (pathPrefix !== (void 0) && !file.source.uri.startsWith(pathPrefix)) {
                return false;
            }
            return extension === (void 0) || posix.extname(file.source.uri).replace(/^\./, "").toLowerCase() === extension;
        };
        const childrenOf: (entity: WorkspaceEntity) => WorkspaceEntity[] = (entity: WorkspaceEntity): WorkspaceEntity[] => {
            if (entity.kind === "project" || entity.kind === "directory") {
                return this.index
                    .children(entity.id)
                    .filter((child: WorkspaceEntity): boolean => child.kind === "directory" || child.kind === "file")
                    .sort(byStructureOrder);
            }
            if (entity.kind === "file") {
                return includeSymbols
                    ? this.index
                          .children(entity.id)
                          .filter((child: WorkspaceEntity): boolean => child.kind === "symbol" || child.kind === "knowledge")
                          .sort(bySourceOrder)
                    : [];
            }
            return this.index
                .children(entity.id)
                .filter((child: WorkspaceEntity): boolean => child.kind === "symbol" || child.kind === "knowledge")
                .sort(bySourceOrder);
        };
        const build: (entity: WorkspaceEntity, depth: number) => WorkspaceOutlineNode | undefined = (entity: WorkspaceEntity, depth: number): WorkspaceOutlineNode | undefined => {
            if (emitted >= limit) {
                truncated = true;
                return (void 0);
            }
            emitted += 1;
            const children: WorkspaceEntity[] = childrenOf(entity).filter(
                (child: WorkspaceEntity): boolean => child.kind !== "file" || fileMatches(child),
            );
            const node: WorkspaceOutlineNode = {
                id: entity.id,
                kind: entity.kind as WorkspaceOutlineNode["kind"],
                label: entity.label,
                path: entity.source.uri,
                ...(entity.structureKind === (void 0) ? {} : { structureKind: entity.structureKind }),
                ...(entity.source.startLine === (void 0) ? {} : { startLine: entity.source.startLine }),
                ...(entity.source.endLine === (void 0) ? {} : { endLine: entity.source.endLine }),
                childCount: children.length,
                children: [],
            };
            if (depth >= maxDepth) {
                return node;
            }
            for (let index: number = 0; index < children.length; index += 1) {
                const child: WorkspaceOutlineNode | undefined = build(children[index], depth + 1);
                if (child === (void 0)) {
                    break;
                }
                node.children.push(child);
            }
            return node;
        };
        const roots: WorkspaceOutlineNode[] = [];
        projects.forEach((project: WorkspaceEntity): void => {
            const node: WorkspaceOutlineNode | undefined = build(project, 0);
            if (node !== (void 0)) {
                roots.push(node);
            }
        });
        return this.reply({ roots, nodes: emitted, truncated, projects: projects.length });
    }

    /**
     * Project-level dependency edges. File-level imports stay on `read`, which
     * is where the caller already pays for content.
     */
    private dependency(args: Record<string, unknown>): WorkspaceResponse {
        const projects: WorkspaceEntity[] = this.projectScope(args.projectId as string | undefined);
        const direction: "incoming" | "outgoing" | "both" = (args.direction as "incoming" | "outgoing" | "both" | undefined) ?? "both";
        const offset: number = (args.offset as number | undefined) ?? 0;
        const limit: number = Math.min((args.limit as number | undefined) ?? 100, 200);
        const end: number = Math.min(projects.length, offset + limit);
        const rows: WorkspaceProjectDependency[] = projects
            .slice(offset, end)
            .map((project: WorkspaceEntity): WorkspaceProjectDependency => ({
                projectId: project.id,
                label: project.label,
                dependencies: direction === "incoming" ? [] : this.projectEdges(project.id, "outgoing", "to"),
                dependents: direction === "outgoing" ? [] : this.projectEdges(project.id, "incoming", "from"),
            }));
        return this.reply({ projects: rows, total: projects.length, nextOffset: end < projects.length ? end : null });
    }

    private projectEdges(projectId: string, direction: "incoming" | "outgoing", side: "from" | "to"): WorkspaceDependencyEdge[] {
        const seen: Set<string> = new Set<string>();
        const edges: WorkspaceDependencyEdge[] = [];
        this.index.relations(projectId, direction, "project_depends_on").forEach((edge: WorkspaceRelation): void => {
            const target: WorkspaceEntity | undefined = this.index.entity(side === "from" ? edge.from : edge.to);
            if (target === (void 0) || seen.has(target.id)) {
                return;
            }
            seen.add(target.id);
            edges.push({
                id: target.id,
                kind: target.kind,
                label: target.label,
                path: target.source.uri,
                method: edge.method,
                ...(edge.source.startLine === (void 0) ? {} : { line: edge.source.startLine }),
            });
        });
        return edges.sort((left: WorkspaceDependencyEdge, right: WorkspaceDependencyEdge): number =>
            left.path < right.path ? -1 : left.path > right.path ? 1 : left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
        );
    }

    /**
     * Reactive tree. In process every node is a Proxy: `label`, `summary`,
     * `tags`, `revision`, `childCount` and `children` are computed on first
     * access and the child index is cached until `reactive_write` invalidates
     * it. `toJSON` builds the bounded plain projection the wire sees, so the
     * laziness cannot grow a response without bound.
     */
    private reactiveRead(args: Record<string, unknown>): WorkspaceResponse {
        const nodeId: string | undefined = args.nodeId as string | undefined;
        if (nodeId !== (void 0) && args.projectId !== (void 0)) {
            return fail("invalid_arguments");
        }
        const roots: WorkspaceEntity[] = nodeId === (void 0) ? this.projectScope(args.projectId as string | undefined) : [this.requireEntity(nodeId)];
        const maxDepth: number = Math.min((args.maxDepth as number | undefined) ?? 8, 12);
        const limit: number = Math.min((args.limit as number | undefined) ?? 500, 2000);
        const nodes: Record<string, unknown>[] = roots.map((entity: WorkspaceEntity): Record<string, unknown> => this.reactiveProxy(entity, maxDepth, limit));
        return this.reply({ revision: this.index.revision, cacheVersion: this.cacheVersion, roots: nodes, nodes: nodes.length });
    }

    private reactiveProxy(entity: WorkspaceEntity, maxDepth: number, limit: number): Record<string, unknown> {
        const base: Record<string, unknown> = {};
        /**
         * A fresh budget per serialization: the same proxy may be stringified
         * more than once (service reply, then executor), and a shared counter
         * would make the second pass look truncated.
         */
        const plain: () => WorkspaceReactiveNode = (): WorkspaceReactiveNode => this.reactivePlain(entity, maxDepth, limit, { nodes: 0 }, 0);
        return new Proxy(base, {
            get: (host: Record<string, unknown>, property: string | symbol): unknown => {
                if (property === "toJSON") {
                    return plain;
                }
                if (typeof(property) !== "string") {
                    return (void 0);
                }
                switch (property) {
                    case "id":
                        return entity.id;
                    case "kind":
                        return entity.kind;
                    case "label":
                        return this.reactiveLabel(entity);
                    case "summary":
                        return this.reactiveSummary(entity);
                    case "tags":
                        return this.reactiveTags(entity);
                    case "path":
                        return entity.source.uri;
                    case "structureKind":
                        return entity.structureKind;
                    case "startLine":
                        return entity.source.startLine;
                    case "endLine":
                        return entity.source.endLine;
                    case "revision":
                        return this.revisionOf(entity);
                    case "childCount":
                        return this.reactiveChildren(entity).length;
                    case "children":
                        return this.reactiveChildren(entity).map((child: WorkspaceEntity): Record<string, unknown> =>
                            this.reactiveProxy(child, maxDepth, limit),
                        );
                    case "hasOwnProperty":
                        return Object.prototype.hasOwnProperty;
                    default:
                        return host[property];
                }
            },
            ownKeys: (): ArrayLike<string | symbol> => [...ReactiveKeys],
            getOwnPropertyDescriptor: (): PropertyDescriptor => ({ configurable: true, enumerable: true }),
            has: (host: Record<string, unknown>, property: string | symbol): boolean =>
                typeof(property) === "string" && (ReactiveKeys.includes(property) || property in host),
        });
    }

    private reactivePlain(entity: WorkspaceEntity, maxDepth: number, limit: number, budget: ReactiveBudget, depth: number): WorkspaceReactiveNode {
        budget.nodes += 1;
        const children: WorkspaceEntity[] = this.reactiveChildren(entity);
        const node: WorkspaceReactiveNode = {
            id: entity.id,
            kind: entity.kind,
            label: this.reactiveLabel(entity),
            path: entity.source.uri,
            summary: this.reactiveSummary(entity),
            tags: this.reactiveTags(entity),
            ...(entity.structureKind === (void 0) ? {} : { structureKind: entity.structureKind }),
            ...(entity.source.startLine === (void 0) ? {} : { startLine: entity.source.startLine }),
            ...(entity.source.endLine === (void 0) ? {} : { endLine: entity.source.endLine }),
            revision: this.revisionOf(entity),
            childCount: children.length,
            children: [],
        };
        if (depth >= maxDepth) {
            return node;
        }
        for (let index: number = 0; index < children.length; index += 1) {
            if (budget.nodes >= limit) {
                node.truncated = true;
                break;
            }
            node.children.push(this.reactivePlain(children[index], maxDepth, limit, budget, depth + 1));
        }
        return node;
    }

    private reactiveChildren(entity: WorkspaceEntity): WorkspaceEntity[] {
        const cached: WorkspaceEntity[] | undefined = this.reactiveCache.get(entity.id);
        if (cached !== (void 0)) {
            return cached;
        }
        const structural: boolean = entity.kind === "project" || entity.kind === "directory";
        const children: WorkspaceEntity[] = this.index
            .children(entity.id)
            .filter(
                (child: WorkspaceEntity): boolean =>
                    structural ? child.kind === "directory" || child.kind === "file" : child.kind === "symbol" || child.kind === "knowledge",
            )
            .sort(structural ? byStructureOrder : bySourceOrder);
        this.reactiveCache.set(entity.id, children);
        return children;
    }

    private reactiveLabel(entity: WorkspaceEntity): string {
        return this.reactiveOverrides.get(entity.id)?.label ?? entity.label;
    }

    private reactiveSummary(entity: WorkspaceEntity): string {
        return this.reactiveOverrides.get(entity.id)?.summary ?? entity.summary;
    }

    private reactiveTags(entity: WorkspaceEntity): string[] {
        return this.reactiveOverrides.get(entity.id)?.tags ?? entity.tags ?? [];
    }

    /**
     * Drop the cached children of the node and every ancestor and bump the
     * version a caller can compare. The returned ids describe what was
     * refreshed, whether or not an entry existed for it.
     */
    private invalidateReactive(nodeId: string): string[] {
        const invalidated: string[] = [];
        let entity: WorkspaceEntity | undefined = this.index.entity(nodeId);
        while (entity !== (void 0) && invalidated.length < 64) {
            this.reactiveCache.delete(entity.id);
            invalidated.push(entity.id);
            entity = entity.parentId === (void 0) ? (void 0) : this.index.entity(entity.parentId);
        }
        this.cacheVersion += 1;
        return invalidated;
    }

    /**
     * Reactive write. Annotations stay service-local; `content` is the guarded
     * file write and reuses the allocation, CAS and host writer of `write`.
     */
    private reactiveWrite(args: Record<string, unknown>): WorkspaceResponse {
        const nodeId: string = args.nodeId as string;
        const property: WorkspaceReactiveProperty = args.property as WorkspaceReactiveProperty;
        const entity: WorkspaceEntity = this.requireEntity(nodeId);
        const value: unknown = args.value;
        if (property === "content") {
            if (typeof(value) !== "string") {
                return fail("invalid_arguments");
            }
            const item: Materialization | undefined = this.contexts.get(args.contextId as string);
            if (item === (void 0)) {
                return fail("not_available");
            }
            const response: WorkspaceResponse = this.write(item, {
                nodeId,
                content: value,
                ...(args.expectRevision === (void 0) ? {} : { expectRevision: args.expectRevision }),
                ...(args.dryRun === (void 0) ? {} : { dryRun: args.dryRun }),
            });
            /**
             * A real content write also invalidates the reactive cache; a
             * dry run changed nothing, so it must not bump the version. The
             * cache coordinates are reported even on the content path so the
             * reply shape matches the annotation path.
             */
            if (response.ok && args.dryRun !== true) {
                const invalidated: string[] = this.invalidateReactive(nodeId);
                response.data.cacheVersion = this.cacheVersion;
                response.data.invalidated = invalidated;
            }
            return response;
        }
        if (property !== "summary" && property !== "label" && property !== "tags") {
            return fail("invalid_arguments");
        }
        /**
         * Work on a copy: a dry run must not mutate the stored overlay through
         * a shared object reference.
         */
        const existing: ReactiveOverrides | undefined = this.reactiveOverrides.get(nodeId);
        const overrides: ReactiveOverrides = {
            ...(existing === (void 0) ? {} : existing),
            ...(existing?.tags === (void 0) ? {} : { tags: [...existing.tags] }),
        };
        if (property === "tags") {
            if (!Array.isArray(value) || value.some((item: unknown): boolean => typeof(item) !== "string")) {
                return fail("invalid_arguments");
            }
            overrides.tags = [...(value as string[])];
        } else {
            if (typeof(value) !== "string") {
                return fail("invalid_arguments");
            }
            if (property === "summary") {
                overrides.summary = value;
            } else {
                overrides.label = value;
            }
        }
        if (args.dryRun === true) {
            return this.reply({
                nodeId,
                property,
                value: property === "tags" ? overrides.tags : overrides[property],
                revision: this.revisionOf(entity),
                dryRun: true,
                cacheVersion: this.cacheVersion,
                invalidated: [],
            });
        }
        this.reactiveOverrides.set(nodeId, overrides);
        const invalidated: string[] = this.invalidateReactive(nodeId);
        return this.reply({
            nodeId,
            property,
            value: property === "tags" ? overrides.tags : overrides[property],
            revision: this.revisionOf(entity),
            cacheVersion: this.cacheVersion,
            invalidated,
        });
    }

    /**
     * Comparable project tree. Every node is a project/directory/file; files
     * carry the content revision plus byte/line metrics so two snapshots can be
     * diffed without bodies. `includeContent` is gated by the materialized
     * Context and never widens what the Frame already made readable.
     */
    private diffRead(args: Record<string, unknown>): WorkspaceResponse {
        const projects: WorkspaceEntity[] = this.projectScope(args.projectId as string | undefined);
        const limit: number = Math.min((args.limit as number | undefined) ?? 500, 2000);
        const includeContent: boolean = args.includeContent === true;
        const context: Materialization | undefined = includeContent ? this.contexts.get(args.contextId as string) : (void 0);
        if (includeContent && context === (void 0)) {
            return fail("not_available");
        }
        const pathPrefix: string | undefined = args.pathPrefix as string | undefined;
        const extension: string | undefined = (args.extension as string | undefined)?.replace(/^\./, "").toLowerCase();
        const fileMatches: (file: WorkspaceEntity) => boolean = (file: WorkspaceEntity): boolean => {
            if (pathPrefix !== (void 0) && !file.source.uri.startsWith(pathPrefix)) {
                return false;
            }
            return extension === (void 0) || posix.extname(file.source.uri).replace(/^\./, "").toLowerCase() === extension;
        };
        let emitted: number = 0;
        let files: number = 0;
        let truncated: boolean = false;
        const build: (entity: WorkspaceEntity) => WorkspaceDiffNode | undefined = (entity: WorkspaceEntity): WorkspaceDiffNode | undefined => {
            if (emitted >= limit) {
                truncated = true;
                return (void 0);
            }
            emitted += 1;
            const children: WorkspaceEntity[] = this.index
                .children(entity.id)
                .filter((child: WorkspaceEntity): boolean => child.kind === "directory" || (child.kind === "file" && fileMatches(child)))
                .sort(byStructureOrder);
            const metrics: { bytes: number | null; lines: number | null; } =
                entity.kind === "file" ? this.contentMetrics(entity) : { bytes: null, lines: null };
            const node: WorkspaceDiffNode = {
                id: entity.id,
                kind: entity.kind as WorkspaceDiffNode["kind"],
                label: entity.label,
                path: entity.source.uri,
                /**
                 * Revision and metrics must describe the same text. A file that
                 * was written through this service serves the accepted content,
                 * so its revision is the writer's; directories never carry an
                 * accepted write and keep the snapshot revision.
                 */
                revision: this.revisionOf(entity),
                bytes: metrics.bytes,
                lines: metrics.lines,
                content: null,
                contentOmitted: false,
                contentTruncated: false,
                childCount: children.length,
                children: [],
            };
            if (entity.kind === "file") {
                files += 1;
                if (includeContent) {
                    const content: string | undefined = context !== (void 0) && context.readable.has(entity.id) ? this.contentOf(entity) : (void 0);
                    node.contentOmitted = content === (void 0);
                    node.contentTruncated = content !== (void 0) && content.length > this.limits.maxReadChars;
                    node.content = content === (void 0) ? null : content.slice(0, this.limits.maxReadChars);
                }
            }
            for (let index: number = 0; index < children.length; index += 1) {
                const child: WorkspaceDiffNode | undefined = build(children[index]);
                if (child === (void 0)) {
                    break;
                }
                node.children.push(child);
            }
            return node;
        };
        const roots: WorkspaceDiffNode[] = [];
        projects.forEach((project: WorkspaceEntity): void => {
            const node: WorkspaceDiffNode | undefined = build(project);
            if (node !== (void 0)) {
                roots.push(node);
            }
        });
        return this.reply({ revision: this.index.revision, roots, files, nodes: emitted, truncated });
    }

    private contentMetrics(entity: WorkspaceEntity): { bytes: number | null; lines: number | null; } {
        const content: string | undefined = this.contentOf(entity);
        return content === (void 0)
            ? { bytes: null, lines: null }
            : { bytes: new TextEncoder().encode(content).length, lines: lineStartsOf(content).length };
    }

    /**
     * Write from a diff decision: one whole-file replacement, a set of 1-based
     * line splices, or a set of UTF-8 byte splices. Line/byte changes are
     * applied bottom-up, the assembled text is diffed against the current
     * content to report hunks, and persistence goes through the same host
     * writer, CAS and overlay as `write`.
     */
    private diffWrite(item: Materialization, args: Record<string, unknown>): WorkspaceResponse {
        const nodeId: string = args.nodeId as string;
        if (!item.readable.has(nodeId)) {
            return fail("not_available");
        }
        const entity: WorkspaceEntity = this.requireEntity(nodeId);
        if (entity.kind !== "file") {
            return fail("invalid_arguments");
        }
        const current: string | undefined = this.contentOf(entity);
        if (current === (void 0)) {
            return fail("not_available");
        }
        const previousRevision: string = this.revisionOf(entity);
        const expectRevision: string | undefined = args.expectRevision as string | undefined;
        if (expectRevision !== (void 0) && expectRevision !== previousRevision) {
            return fail("fingerprint_mismatch");
        }
        const changes: Record<string, unknown>[] | undefined = args.changes as Record<string, unknown>[] | undefined;
        const byteChanges: Record<string, unknown>[] | undefined = args.byteChanges as Record<string, unknown>[] | undefined;
        /**
         * Presence, not length, selects the mode: a caller that sent both
         * `content` and an (even empty) `changes` list made an addressing
         * mistake rather than asking for a no-op.
         */
        const hasContent: boolean = args.content !== (void 0);
        const hasChanges: boolean = args.changes !== (void 0);
        const hasByteChanges: boolean = args.byteChanges !== (void 0);
        if ((hasContent ? 1 : 0) + (hasChanges ? 1 : 0) + (hasByteChanges ? 1 : 0) !== 1) {
            return fail("invalid_arguments");
        }
        if ((hasChanges && (!Array.isArray(changes) || changes.length === 0)) || (hasByteChanges && (!Array.isArray(byteChanges) || byteChanges.length === 0))) {
            return fail("invalid_arguments");
        }
        let next: string;
        let strategy: "whole" | "lines" | "bytes";
        try {
            if (hasContent) {
                next = args.content as string;
                strategy = "whole";
            } else if (hasChanges) {
                next = applyLineChanges(current, changes!.map(asLineChange), this.limits.maxWriteChars);
                strategy = "lines";
            } else {
                next = applyByteChanges(current, byteChanges!.map(asByteChange), this.limits.maxWriteChars);
                strategy = "bytes";
            }
        } catch (error: unknown) {
            return fail(error instanceof WorkspaceDiffError ? error.code : "invalid_arguments");
        }
        if (next.length > this.limits.maxWriteChars) {
            return fail("capacity_exceeded");
        }
        const summary: DiffSummary = summarizeDiff(entity.source.uri, current, next, args.contextLines as number | undefined);
        const bytes: number = new TextEncoder().encode(next).length;
        const payload: Record<string, unknown> = {
            nodeId,
            path: entity.source.uri,
            strategy,
            dryRun: args.dryRun === true,
            previousRevision,
            bytes,
            lines: lineStartsOf(next).length,
            added: summary.added,
            removed: summary.removed,
            unchanged: summary.unchanged,
            diffTruncated: summary.truncated,
            hunks: summary.hunks as WorkspaceDiffHunk[],
            remainingTokens: item.allocation.remainingTokens,
            ...this.impacts(nodeId),
        };
        if (args.dryRun === true) {
            return this.reply({ ...payload, revision: null });
        }
        if (this.writer === (void 0)) {
            return fail("write_unavailable");
        }
        const outcome: WorkspaceWriteOutcome = this.writer.write({
            agentId: this.agentId,
            nodeId,
            uri: entity.source.uri,
            content: next,
            previousRevision,
        });
        if (writeRejected(outcome)) {
            return fail(outcome.code);
        }
        if (typeof(outcome.revision) !== "string" || outcome.revision.length === 0) {
            return fail("internal_error");
        }
        this.writes.set(nodeId, { content: next, revision: outcome.revision, bytes: outcome.bytes ?? bytes });
        this.invalidateReactive(nodeId);
        return this.reply({ ...payload, revision: outcome.revision });
    }

    private builtInComponents(): HostComponent[] {
        const components: HostComponent[] = [
            {
                id: WorkspaceServiceId,
                kind: "service",
                name: "amp.workspace",
                description: "Authorized project discovery, context materialization and bounded detail reads.",
                purpose: "Serve the amp.workspace v1 protocol to agents.",
                version: "1.0.0",
                status: "active",
            },
        ];
        for (const tool of this.definitions) {
            components.push({
                id: tool.name,
                kind: "tool",
                name: tool.name,
                description: tool.description,
                purpose: "Agent-callable workspace tool.",
                status: "active",
            });
        }
        return components;
    }

    private materialize(frameId: string, budgetTokens: number): WorkspaceResponse {
        const allocation: Allocation | undefined = this.frames.get(frameId);
        if (allocation === (void 0) || allocation.state === "released" || allocation.state === "revoked") {
            return fail("frame_unavailable");
        }
        if (allocation.contextId !== (void 0)) {
            const existing: Materialization = this.contexts.get(allocation.contextId)!;
            if (existing.requestedTokens !== budgetTokens) {
                return fail("invalid_arguments");
            }
            const response: WorkspaceResponse = structuredClone(existing.response);
            if (response.ok) {
                response.data.remainingTokens = allocation.remainingTokens;
            }
            return response;
        }
        if (this.contexts.size >= this.limits.maxContexts) {
            return fail("capacity_exceeded");
        }
        const cap: number = Math.min(budgetTokens, this.limits.maxViewTokens, allocation.remainingTokens);
        if (cap <= 0) {
            return fail("budget_exhausted");
        }
        const context: Context = this.index.context(allocation.frame, cap);
        const view: ContextView = context.view!;
        const included: Set<string> = new Set(view.nodes.map((node): string => node.id));
        const readable: Set<string> = new Set(
            allocation.frame.slots.filter((slot): boolean => slot.state === "active" && included.has(slot.target.id)).map((slot): string => slot.target.id),
        );
        const contextId: string = `ctx.${randomUUID()}`;
        const response: WorkspaceResponse = this.reply({
            contextId,
            frameId,
            text: view.text,
            tokens: view.tokens,
            budgetTokens: cap,
            remainingTokens: allocation.remainingTokens - view.tokens,
            includedIds: [...included],
            readableIds: [...readable],
            deferredIds: view.deferred.map((node): string => node.id),
            missingRefs: view.missingRefs,
            relations: view.relations,
            unresolvedDependencies: view.unresolvedDependencies,
            omissions: view.omissions,
        });
        allocation.remainingTokens -= view.tokens;
        allocation.state = "materialized";
        allocation.contextId = contextId;
        this.contexts.set(contextId, { context, allocation, readable, response: structuredClone(response), requestedTokens: budgetTokens });
        return response;
    }

    /**
     * Bounded detail read. The page is addressed by characters, lines or bytes,
     * and the reply carries the containing file's two impact directions:
     * `importation` (what this file imports) and `exportation` (which relative
     * files import it), which is what lets a caller scope an edit without a
     * second relation query.
     */
    private read(item: Materialization, args: Record<string, unknown>): WorkspaceResponse {
        const nodeId: string = args.nodeId as string;
        if (!item.readable.has(nodeId)) {
            return fail("not_available");
        }
        const remaining: number = item.allocation.remainingTokens;
        if (remaining <= 0) {
            return fail("budget_exhausted");
        }
        const entity: WorkspaceEntity = this.requireEntity(nodeId);
        const file: WorkspaceEntity | undefined = this.containingFile(nodeId);
        /**
         * A symbol or knowledge page is a snapshot extraction of its file. Once
         * that file has been rewritten through this service the extraction no
         * longer describes the current bytes, so the page fails closed instead
         * of presenting stale text with a snapshot revision.
         */
        if (file !== (void 0) && file.id !== nodeId && this.writes.has(file.id)) {
            return fail("stale_detail");
        }
        const accepted: AcceptedWrite | undefined = file !== (void 0) && file.id === nodeId ? this.writes.get(nodeId) : (void 0);
        const content: string | undefined = accepted !== (void 0) ? accepted.content : item.context.expand(nodeId);
        if (content === (void 0)) {
            return fail("not_available");
        }
        const page: DetailPage = readPage(content, args, this.limits.maxReadChars, remaining);
        const tokens: number = estimateTokens(page.text);
        /**
         * Line mode may return one line whole when it is larger than the page
         * budget. The Frame budget is still hard, so a page that cannot be paid
         * for is refused instead of driving the allocation negative.
         */
        if (tokens > remaining) {
            return fail("budget_exhausted");
        }
        const response: WorkspaceResponse = this.reply({
            nodeId,
            source: accepted === (void 0) ? entity.source : { ...entity.source, revision: accepted.revision },
            offset: page.offset,
            text: page.text,
            nextOffset: page.nextOffset,
            totalChars: content.length,
            tokens,
            remainingTokens: remaining - tokens,
            ...page.fields,
            ...this.impacts(nodeId),
        });
        item.allocation.remainingTokens -= tokens;
        return response;
    }

    /**
     * Host-delegated write. Authorization is the same allocation that `read`
     * requires: the target file must be in the materialized Context's readable
     * set, so a write cannot widen the Frame. The snapshot is not re-parsed, so
     * the returned impact lists describe the indexed graph, while detail reads
     * of this node immediately serve the accepted text.
     */
    private write(item: Materialization, args: Record<string, unknown>): WorkspaceResponse {
        const nodeId: string = args.nodeId as string;
        if (!item.readable.has(nodeId)) {
            return fail("not_available");
        }
        const entity: WorkspaceEntity = this.requireEntity(nodeId);
        if (entity.kind !== "file") {
            return fail("invalid_arguments");
        }
        const current: string | undefined = this.contentOf(entity);
        if (current === (void 0)) {
            return fail("not_available");
        }
        const previousRevision: string = this.revisionOf(entity);
        const expectRevision: string | undefined = args.expectRevision as string | undefined;
        if (expectRevision !== (void 0) && expectRevision !== previousRevision) {
            return fail("fingerprint_mismatch");
        }
        const edit: WriteEdit = applyWrite(current, args);
        if (edit.content.length > this.limits.maxWriteChars) {
            return fail("capacity_exceeded");
        }
        const bytes: number = new TextEncoder().encode(edit.content).length;
        const summary: Record<string, unknown> = {
            nodeId,
            path: entity.source.uri,
            mode: edit.mode,
            dryRun: args.dryRun === true,
            previousRevision,
            ...edit.fields,
            bytes,
            lines: lineStartsOf(edit.content).length,
            remainingTokens: item.allocation.remainingTokens,
            ...this.impacts(nodeId),
        };
        if (args.dryRun === true) {
            return this.reply({ ...summary, revision: null });
        }
        if (this.writer === (void 0)) {
            return fail("write_unavailable");
        }
        const outcome: WorkspaceWriteOutcome = this.writer.write({
            agentId: this.agentId,
            nodeId,
            uri: entity.source.uri,
            content: edit.content,
            previousRevision,
        });
        if (writeRejected(outcome)) {
            return fail(outcome.code);
        }
        if (typeof(outcome.revision) !== "string" || outcome.revision.length === 0) {
            return fail("internal_error");
        }
        this.writes.set(nodeId, { content: edit.content, revision: outcome.revision, bytes: outcome.bytes ?? bytes });
        return this.reply({ ...summary, revision: outcome.revision });
    }

    /**
     * Nearest enclosing file entity. Symbol and knowledge nodes inherit their
     * file's imports, so reading a function body still reports the module's
     * relative dependencies. Projects, directories and packages have no file.
     */
    private containingFile(nodeId: string): WorkspaceEntity | undefined {
        let entity: WorkspaceEntity | undefined = this.index.entity(nodeId);
        for (let depth: number = 0; entity !== (void 0) && depth < 64; depth += 1) {
            if (entity.kind === "file") {
                return entity;
            }
            entity = entity.parentId === (void 0) ? (void 0) : this.index.entity(entity.parentId);
        }
        return (void 0);
    }

    private contentOf(entity: WorkspaceEntity): string | undefined {
        const accepted: AcceptedWrite | undefined = this.writes.get(entity.id);
        if (accepted !== (void 0)) {
            return accepted.content;
        }
        return entity.detailRef === (void 0) ? (void 0) : this.store.get(entity.detailRef);
    }

    private revisionOf(entity: WorkspaceEntity): string {
        return this.writes.get(entity.id)?.revision ?? entity.source.revision;
    }

    /**
     * Relative files on both sides of the `imports` relation.
     *
     * `exportation` walks incoming edges: another file importing this one is a
     * consumer of its exports, which is what "who breaks if I change this?"
     * means. `importation` walks outgoing edges and keeps bare package
     * specifiers in a separate list because they have no relative path.
     */
    private impacts(nodeId: string): WorkspaceImpacts {
        const emptyExportation: WorkspaceExportation = { path: null, files: [], total: 0, truncated: false };
        const emptyImportation: WorkspaceImportation = { path: null, files: [], external: [], externalTotal: 0, externalTruncated: false, total: 0, truncated: false };
        const file: WorkspaceEntity | undefined = this.containingFile(nodeId);
        if (file === (void 0)) {
            return { exportation: emptyExportation, importation: emptyImportation };
        }
        const limit: number = this.limits.maxFileLinks;
        const importers: Map<string, WorkspaceFileLink> = new Map();
        this.index.relations(file.id, "incoming", "imports").forEach((edge: WorkspaceRelation): void => {
            const source: WorkspaceEntity | undefined = this.containingFile(edge.from);
            if (source !== (void 0) && !importers.has(source.id)) {
                importers.set(source.id, this.linkOf(source, edge));
            }
        });
        const dependencies: Map<string, WorkspaceFileLink> = new Map();
        const external: Set<string> = new Set();
        this.index.relations(file.id, "outgoing", "imports").forEach((edge: WorkspaceRelation): void => {
            const target: WorkspaceEntity | undefined = this.index.entity(edge.to);
            if (target === (void 0)) {
                return;
            }
            if (target.kind === "package") {
                external.add(target.label);
                return;
            }
            const dependency: WorkspaceEntity | undefined = this.containingFile(target.id);
            if (dependency !== (void 0) && !dependencies.has(dependency.id)) {
                dependencies.set(dependency.id, this.linkOf(dependency, edge));
            }
        });
        const sortLinks: (links: Map<string, WorkspaceFileLink>) => WorkspaceFileLink[] = (links: Map<string, WorkspaceFileLink>): WorkspaceFileLink[] =>
            [...links.values()].sort(
                (left: WorkspaceFileLink, right: WorkspaceFileLink): number =>
                    (left.path < right.path ? -1 : left.path > right.path ? 1 : 0) ||
                    (left.line ?? 0) - (right.line ?? 0) ||
                    (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
            );
        const exporters: WorkspaceFileLink[] = sortLinks(importers);
        const imported: WorkspaceFileLink[] = sortLinks(dependencies);
        const externals: string[] = [...external].sort();
        return {
            exportation: {
                path: file.source.uri,
                files: exporters.slice(0, limit),
                total: exporters.length,
                truncated: exporters.length > limit,
            },
            importation: {
                path: file.source.uri,
                files: imported.slice(0, limit),
                external: externals.slice(0, limit),
                externalTotal: externals.length,
                externalTruncated: externals.length > limit,
                total: imported.length,
                truncated: imported.length > limit,
            },
        };
    }

    private linkOf(entity: WorkspaceEntity, edge: WorkspaceRelation): WorkspaceFileLink {
        return {
            id: entity.id,
            path: entity.source.uri,
            ...(edge.source.startLine === (void 0) ? {} : { line: edge.source.startLine }),
            method: edge.method,
        };
    }
}
