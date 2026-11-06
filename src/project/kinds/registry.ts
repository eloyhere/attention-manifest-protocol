import { isNumber, isString, Optional, SynchronousOrderedMap, SynchronousUnorderedSet } from "semantic-typescript";
import { validateEnvironment } from "../environment.ts";
import type { ProjectEnvironment } from "../environment.ts";
import type { ProjectKindDefinition, ProjectKindMatch, ProjectMarker } from "./types.ts";

export interface ProjectKindRegistryOptions {
    readonly definitions?: readonly ProjectKindDefinition[];
    readonly maxResults?: number;
}

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const MATCHES: ReadonlySet<string> = new Set(["exact", "prefix", "suffix"]);
const DEFAULT_MAX_RESULTS = Number.MAX_SAFE_INTEGER;

/**
 * Validate a canonical workspace-relative POSIX path.
 *
 * Detection input and marker paths reject the workspace root itself; callers
 * pass files and evidence, not a project directory.
 */
function requireWorkspacePath(value: unknown, label: string): string {
    if (!isString(value) || value.length === 0) throw new TypeError(`${label} must be a non-empty workspace-relative POSIX path`);
    if (value.trim() !== value) throw new TypeError(`${label} must not have surrounding whitespace`);
    if (/[\0\r\n]/.test(value)) throw new TypeError(`${label} must not contain control characters`);
    if (value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:/.test(value)) throw new TypeError(`${label} must be workspace-relative`);
    if (value.includes("\\")) throw new TypeError(`${label} must use POSIX separators`);
    const segments = value.split("/");
    if (segments.some(segment => segment.length === 0 || segment === "." || segment === "..")) throw new TypeError(`${label} must be a canonical workspace-relative path`);
    return value;
}

function isRecord(value: unknown): boolean {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireMaxResults(value: unknown): number {
    if (!isNumber(value) || !Number.isInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) throw new TypeError("maxResults must be a non-negative integer");
    return value;
}

function requireMarker(value: unknown): ProjectMarker {
    if (!isRecord(value)) throw new TypeError("project kind marker must be an object");
    const candidate = value as Partial<ProjectMarker>;
    const match = candidate.match;
    if (!isString(match) || !MATCHES.has(match)) throw new TypeError("project kind marker match must be exact, prefix or suffix");
    const rawPath = candidate.path;
    const markerPath = match === "prefix" && isString(rawPath) && rawPath.endsWith("/") ? rawPath.slice(0, -1) : rawPath;
    const path = requireWorkspacePath(markerPath, "project kind marker path");
    if (!isNumber(candidate.weight) || !Number.isInteger(candidate.weight) || candidate.weight < 1 || candidate.weight > 3) throw new TypeError("project kind marker weight must be an integer from 1 to 3");
    if (!isString(candidate.label) || candidate.label.trim().length === 0) throw new TypeError("project kind marker label must be non-empty");
    return Object.freeze({ path, match: match as ProjectMarker["match"], weight: candidate.weight, label: candidate.label.trim() });
}

/** Clone and deeply freeze an environment so no caller-owned state leaks. */
function freezeEnvironment(value: ProjectEnvironment): ProjectEnvironment {
    const variables = Object.freeze(Object.fromEntries(Object.entries(value.variables)));
    const paths = Object.freeze([...value.paths]);
    const dependencies = Object.freeze(value.dependencies.map(dependency => Object.freeze({ ...dependency })));
    return Object.freeze({ variables, paths, dependencies });
}

function validateDefinition(value: ProjectKindDefinition): ProjectKindDefinition {
    if (!isRecord(value)) throw new TypeError("project kind definition must be an object");
    const candidate = value as Partial<ProjectKindDefinition>;
    const id = candidate.id;
    if (!isString(id) || id.length === 0) throw new TypeError("project kind id must be a non-empty string");
    if (!ID_PATTERN.test(id)) throw new TypeError(`invalid project kind id: ${id}`);
    const displayName = candidate.displayName;
    if (!isString(displayName) || displayName.trim().length === 0) throw new TypeError("project kind displayName must be non-empty");
    const language = candidate.language;
    if (!isString(language) || language.trim().length === 0) throw new TypeError("project kind language must be non-empty");
    const markerInput = candidate.markers;
    if (!Array.isArray(markerInput) || markerInput.length === 0) throw new TypeError("project kind markers must be a non-empty array");
    const markerKeys = new SynchronousUnorderedSet<string>();
    const markers: ProjectMarker[] = [];
    for (const marker of markerInput) {
        const normalized = requireMarker(marker);
        const key = `${normalized.match}\0${normalized.path}`;
        if (markerKeys.contains(key)) throw new TypeError(`duplicate project kind marker: ${normalized.match} ${normalized.path}`);
        markerKeys.add(key);
        markers.push(normalized);
    }
    const environment = candidate.environment;
    if (!isRecord(environment)) throw new TypeError("project kind environment must be an object");
    validateEnvironment(environment as ProjectEnvironment);
    const priority = candidate.priority;
    if (!isNumber(priority) || !Number.isInteger(priority) || priority < 0 || priority > 100) throw new TypeError("project kind priority must be an integer from 0 to 100");
    const notes = candidate.notes;
    if (notes !== undefined && !isString(notes)) throw new TypeError("project kind notes must be a string when provided");
    return Object.freeze({
        id,
        displayName: displayName.trim(),
        language: language.trim(),
        markers: Object.freeze(markers),
        environment: freezeEnvironment(environment as ProjectEnvironment),
        priority,
        ...(notes === undefined ? {} : { notes: notes.trim() }),
    });
}

function markerMatches(marker: ProjectMarker, file: string): boolean {
    if (marker.match === "exact") return file === marker.path;
    if (marker.match === "prefix") return file === marker.path || file.startsWith(`${marker.path}/`);
    return file.endsWith(marker.path);
}

function compareMatches(left: ProjectKindMatch, right: ProjectKindMatch): number {
    if (left.score !== right.score) return right.score - left.score;
    if (left.kind.priority !== right.kind.priority) return right.kind.priority - left.kind.priority;
    return left.kind.id < right.kind.id ? -1 : left.kind.id > right.kind.id ? 1 : 0;
}

/**
 * In-memory registry of declarative project kind definitions.
 *
 * Registration is versioned (every successful change advances `version` and
 * `epoch`), unregistered identifiers stay retired forever, detection is a pure
 * function of the supplied file list, and every returned value is frozen.
 */
export class ProjectKindRegistry {
    private readonly definitions = new SynchronousOrderedMap<string, ProjectKindDefinition>();
    private readonly retired = new SynchronousUnorderedSet<string>();
    private readonly maxResults: number;
    private currentEpoch = 0;

    constructor(options: ProjectKindRegistryOptions = {}) {
        if (!isRecord(options)) throw new TypeError("project kind registry options must be an object");
        this.maxResults = options.maxResults === undefined ? DEFAULT_MAX_RESULTS : requireMaxResults(options.maxResults);
        if (options.definitions !== undefined) this.registerMany(options.definitions);
    }

    get version(): number { return this.currentEpoch; }
    get epoch(): number { return this.currentEpoch; }

    register(definition: ProjectKindDefinition): ProjectKindDefinition {
        const candidate = validateDefinition(definition);
        if (this.definitions.containsKey(candidate.id)) throw new TypeError(`project kind id is already registered: ${candidate.id}`);
        if (this.retired.contains(candidate.id)) throw new TypeError(`project kind id is permanently retired: ${candidate.id}`);
        this.definitions.put(candidate.id, candidate);
        this.currentEpoch += 1;
        return candidate;
    }

    /** Validate and register a batch atomically; a failure leaves the registry untouched. */
    registerMany(definitions: readonly ProjectKindDefinition[]): readonly ProjectKindDefinition[] {
        if (!Array.isArray(definitions)) throw new TypeError("project kind definitions must be an array");
        const candidates = definitions.map(definition => validateDefinition(definition));
        if (candidates.length === 0) return Object.freeze([]);
        const staged = new SynchronousUnorderedSet<string>();
        for (const candidate of candidates) {
            if (staged.contains(candidate.id) || this.definitions.containsKey(candidate.id)) throw new TypeError(`project kind id is already registered: ${candidate.id}`);
            if (this.retired.contains(candidate.id)) throw new TypeError(`project kind id is permanently retired: ${candidate.id}`);
            staged.add(candidate.id);
        }
        for (const candidate of candidates) this.definitions.put(candidate.id, candidate);
        this.currentEpoch += 1;
        return Object.freeze(candidates);
    }

    /** Remove a definition and permanently retire its identifier. */
    unregister(id: string): boolean {
        if (!isString(id) || !this.definitions.containsKey(id)) return false;
        this.definitions.remove(id);
        this.retired.add(id);
        this.currentEpoch += 1;
        return true;
    }

    find(id: string): Optional<ProjectKindDefinition> {
        return isString(id) ? this.definitions.get(id) : Optional.empty<ProjectKindDefinition>();
    }

    requireKind(id: string): ProjectKindDefinition {
        const definition = this.find(id);
        if (definition.isEmpty()) throw new TypeError(`unknown project kind: ${String(id)}`);
        return definition.get();
    }

    /** Registration-order snapshot; the returned array cannot mutate the registry. */
    list(): readonly ProjectKindDefinition[] {
        return Object.freeze(this.definitions.values().toArray());
    }

    snapshot(): Readonly<{ epoch: number; definitions: readonly ProjectKindDefinition[] }> {
        return Object.freeze({ epoch: this.currentEpoch, definitions: this.list() });
    }

    /**
     * Detect matching project kinds from a host-supplied file list.
     *
     * A marker contributes once, using the first matching file in input order.
     * The score is the sum of matched marker weights; zero-score definitions
     * are omitted. Results sort by score, then priority, then identifier.
     */
    detect(files: readonly string[], options: { readonly maxResults?: number } = {}): readonly ProjectKindMatch[] {
        if (!Array.isArray(files)) throw new TypeError("project kind detection files must be an array");
        if (!isRecord(options)) throw new TypeError("project kind detection options must be an object");
        const candidates: string[] = [];
        for (const file of files) candidates.push(requireWorkspacePath(file, "project detection file path"));
        const limit = options.maxResults === undefined ? this.maxResults : requireMaxResults(options.maxResults);
        const matches: ProjectKindMatch[] = [];
        for (const definition of this.definitions.values()) {
            const matched: ProjectMarker[] = [];
            const evidence: string[] = [];
            let score = 0;
            for (const marker of definition.markers) {
                const hit = candidates.find(file => markerMatches(marker, file));
                if (hit === undefined) continue;
                matched.push(marker);
                evidence.push(hit);
                score += marker.weight;
            }
            if (score === 0) continue;
            matches.push(Object.freeze({ kind: definition, score, matched: Object.freeze(matched), evidence: Object.freeze(evidence) }));
        }
        matches.sort(compareMatches);
        return Object.freeze(matches.slice(0, limit));
    }

    /** Best match, or an empty Optional when no definition matches. */
    best(files: readonly string[]): Optional<ProjectKindMatch> {
        return Optional.ofNullable<ProjectKindMatch>(this.detect(files)[0]);
    }
}
