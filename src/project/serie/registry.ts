import { Optional, SynchronousOrderedMap, SynchronousUnorderedSet, isNumber, isObject, isString, useFrom } from "semantic-typescript";
import type { SerieCapability, SerieDefinition, SerieDetection, SerieKind, SerieMarker, SerieStep } from "./types.ts";

export interface SerieRegistryOptions {
    readonly definitions?: readonly SerieDefinition[];
    readonly maxResults?: number;
}

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const KINDS = new SynchronousUnorderedSet<SerieKind>(["package-manager", "runtime", "build-system", "platform"]);
const CAPABILITIES = new SynchronousUnorderedSet<SerieCapability>(["install", "build", "test", "run", "lint", "package", "bundle"]);
const MATCHES = new SynchronousUnorderedSet<SerieMarker["match"]>(["exact", "prefix", "suffix"]);
const DEFAULT_MAX_RESULTS = Number.MAX_SAFE_INTEGER;

const normalizeId = (value: string): string => value.trim().toLowerCase();

/**
 * Validate a workspace-relative POSIX path.
 *
 * The registry intentionally rejects non-canonical paths (dot segments,
 * duplicate separators, trailing separators and surrounding whitespace) so
 * evidence matching has one unambiguous representation.
 */
function requireWorkspacePath(value: string, label: string): string {
    if (value.length === 0) throw new TypeError(`${label} must be a non-empty workspace-relative path`);
    if (value.trim() !== value) throw new TypeError(`${label} must not have surrounding whitespace`);
    if (/[\0\r\n]/.test(value)) throw new TypeError(`${label} must not contain control characters`);
    if (value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:/.test(value)) throw new TypeError(`${label} must be workspace-relative`);
    if (value.includes("\\")) throw new TypeError(`${label} must use POSIX separators`);
    const segments = value.split("/");
    if (segments.some(segment => segment.length === 0 || segment === "." || segment === "..")) throw new TypeError(`${label} must be a canonical workspace-relative path`);
    return value;
}

function requireMaxResults(value: number): number {
    if (!isNumber(value) || !Number.isInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) throw new TypeError("maxResults must be a non-negative integer");
    return value;
}

function requireMarker(value: SerieMarker): SerieMarker {
    if (!isObject(value)) throw new TypeError("serie marker must be an object");
    if (!isString(value.path)) throw new TypeError("serie marker path must be a string");
    if (!isString(value.match) || !MATCHES.contains(value.match as SerieMarker["match"])) throw new TypeError("serie marker match must be exact, prefix or suffix");
    const markerPath = value.match === "prefix" && value.path.endsWith("/") ? value.path.slice(0, -1) : value.path;
    const path = requireWorkspacePath(markerPath, "serie marker path");
    if (!isNumber(value.weight) || !Number.isInteger(value.weight) || value.weight < 1 || value.weight > 3) throw new TypeError("serie marker weight must be an integer from 1 to 3");
    if (!isString(value.label) || !value.label.trim()) throw new TypeError("serie marker label must be non-empty");
    return Object.freeze({ path, match: value.match as SerieMarker["match"], weight: value.weight, label: value.label.trim() });
}

function validateDefinition(input: SerieDefinition): SerieDefinition {
    if (!isObject(input)) throw new TypeError("serie definition must be an object");
    if (!isString(input.id) || !input.id.trim()) throw new TypeError("serie id must be a non-empty string");
    const id = normalizeId(input.id);
    if (!ID_PATTERN.test(id)) throw new TypeError(`invalid serie id: ${input.id}`);
    if (!isString(input.displayName) || !input.displayName.trim()) throw new TypeError("serie displayName must be non-empty");
    if (!isString(input.kind) || !KINDS.contains(input.kind as SerieKind)) throw new TypeError(`invalid serie kind: ${String(input.kind)}`);
    if (!Array.isArray(input.markers) || input.markers.length === 0) throw new TypeError("serie markers must be a non-empty array");
    const markerKeys = new SynchronousUnorderedSet<string>();
    const markers: SerieMarker[] = [];
    for (const candidate of input.markers) {
        const marker = requireMarker(candidate);
        const key = `${marker.match}\0${marker.path}`;
        if (markerKeys.contains(key)) throw new TypeError(`duplicate serie marker: ${marker.match} ${marker.path}`);
        markerKeys.add(key);
        markers.push(marker);
    }
    if (!Array.isArray(input.capabilities)) throw new TypeError("serie capabilities must be an array");
    const capabilitySet = new SynchronousUnorderedSet<SerieCapability>();
    const capabilities: SerieCapability[] = [];
    for (const candidate of input.capabilities) {
        if (!isString(candidate) || !CAPABILITIES.contains(candidate as SerieCapability)) throw new TypeError(`invalid serie capability: ${String(candidate)}`);
        const capability = candidate as SerieCapability;
        if (capabilitySet.contains(capability)) continue;
        capabilitySet.add(capability);
        capabilities.push(capability);
    }
    if (capabilities.length === 0) throw new TypeError("serie capabilities must not be empty");
    if (!Array.isArray(input.steps)) throw new TypeError("serie steps must be an array");
    const steps: SerieStep[] = [];
    for (const candidate of input.steps) {
        if (!isObject(candidate)) throw new TypeError("serie step must be an object");
        const step = candidate as SerieStep;
        if (!isString(step.capability) || !capabilitySet.contains(step.capability as SerieCapability)) throw new TypeError("serie step capability must be declared in capabilities");
        if (!isString(step.command) || !step.command.trim()) throw new TypeError("serie step command must be non-empty");
        steps.push(Object.freeze({ capability: step.capability as SerieCapability, command: step.command.trim() }));
    }
    if (!isNumber(input.priority) || !Number.isInteger(input.priority) || input.priority < 0 || input.priority > 100) throw new TypeError("serie priority must be an integer from 0 to 100");
    if (input.notes !== undefined && !isString(input.notes)) throw new TypeError("serie notes must be a string when provided");
    const definition: SerieDefinition = {
        id,
        displayName: input.displayName.trim(),
        kind: input.kind as SerieKind,
        markers: Object.freeze(markers),
        capabilities: Object.freeze(capabilities),
        steps: Object.freeze(steps),
        priority: input.priority,
        ...(input.notes === undefined ? {} : { notes: input.notes.trim() }),
    };
    return Object.freeze(definition);
}

function markerMatches(marker: SerieMarker, file: string): boolean {
    if (marker.match === "exact") return file === marker.path;
    if (marker.match === "prefix") return file === marker.path || file.startsWith(`${marker.path}/`);
    return file.endsWith(marker.path);
}

function compareDetections(left: SerieDetection, right: SerieDetection): number {
    if (left.score !== right.score) return right.score - left.score;
    if (left.serie.priority !== right.serie.priority) return right.serie.priority - left.serie.priority;
    return left.serie.id < right.serie.id ? -1 : left.serie.id > right.serie.id ? 1 : 0;
}

/**
 * In-memory registry of declarative serie definitions.
 *
 * Registration is versioned, detection is a pure function of the supplied file
 * list, and no method reads the file system or executes a declared command.
 */
export class SerieRegistry {
    private readonly definitions = new SynchronousOrderedMap<string, SerieDefinition>();
    private readonly retired = new SynchronousUnorderedSet<string>();
    private readonly maxResults: number;
    private currentEpoch = 0;

    constructor(options: SerieRegistryOptions = {}) {
        if (!isObject(options)) throw new TypeError("serie registry options must be an object");
        this.maxResults = options.maxResults === undefined ? DEFAULT_MAX_RESULTS : requireMaxResults(options.maxResults);
        if (options.definitions !== undefined) this.registerMany(options.definitions);
    }

    get version(): number { return this.currentEpoch; }
    get epoch(): number { return this.currentEpoch; }

    register(definition: SerieDefinition): SerieDefinition {
        const candidate = validateDefinition(definition);
        if (this.definitions.containsKey(candidate.id)) throw new TypeError(`serie id is already registered: ${candidate.id}`);
        if (this.retired.contains(candidate.id)) throw new TypeError(`serie id is permanently retired: ${candidate.id}`);
        this.definitions.put(candidate.id, candidate);
        this.currentEpoch += 1;
        return candidate;
    }

    /** Validate and register a batch atomically; a failure leaves the registry untouched. */
    registerMany(definitions: readonly SerieDefinition[]): readonly SerieDefinition[] {
        if (!Array.isArray(definitions)) throw new TypeError("serie definitions must be an array");
        const candidates = definitions.map(definition => validateDefinition(definition));
        if (candidates.length === 0) return Object.freeze([]);
        const staged = new SynchronousOrderedMap<string, SerieDefinition>();
        for (const candidate of candidates) {
            if (staged.containsKey(candidate.id) || this.definitions.containsKey(candidate.id)) throw new TypeError(`serie id is already registered: ${candidate.id}`);
            if (this.retired.contains(candidate.id)) throw new TypeError(`serie id is permanently retired: ${candidate.id}`);
            staged.put(candidate.id, candidate);
        }
        for (const candidate of candidates) this.definitions.put(candidate.id, candidate);
        this.currentEpoch += 1;
        return Object.freeze(candidates);
    }

    /** Remove a definition and permanently retire its id. */
    unregister(id: string): boolean {
        if (!isString(id)) return false;
        const normalized = normalizeId(id);
        if (!this.definitions.containsKey(normalized)) return false;
        this.definitions.remove(normalized);
        this.retired.add(normalized);
        this.currentEpoch += 1;
        return true;
    }

    find(id: string): Optional<SerieDefinition> {
        return isString(id) ? this.definitions.get(normalizeId(id)) : Optional.empty<SerieDefinition>();
    }

    requireDefinition(id: string): SerieDefinition {
        const definition = this.find(id);
        if (definition.isEmpty()) throw new TypeError(`unknown serie: ${String(id)}`);
        return definition.get();
    }

    /** Registration-order snapshot; the returned array cannot mutate the registry. */
    list(): readonly SerieDefinition[] {
        return Object.freeze(this.definitions.values().toArray());
    }

    snapshot(): Readonly<{ epoch: number; definitions: readonly SerieDefinition[] }> {
        return Object.freeze({ epoch: this.currentEpoch, definitions: this.list() });
    }

    /**
     * Detect matching series from a host-supplied file list.
     *
     * A marker contributes once, using the first matching file in input order.
     * The score is the sum of matched marker weights; zero-score definitions
     * are omitted. Results sort by score, then priority, then id.
     */
    detect(files: readonly string[], options: { readonly maxResults?: number } = {}): readonly SerieDetection[] {
        if (!Array.isArray(files)) throw new TypeError("serie detection files must be an array");
        if (!isObject(options)) throw new TypeError("serie detection options must be an object");
        const candidates: string[] = [];
        for (const file of files) {
            if (!isString(file)) throw new TypeError("serie detection file path must be a string");
            candidates.push(requireWorkspacePath(file, "serie detection file path"));
        }
        const limit = options.maxResults === undefined ? this.maxResults : requireMaxResults(options.maxResults);
        const detections: SerieDetection[] = [];
        for (const definition of this.definitions.values()) {
            const matched: SerieMarker[] = [];
            const evidence: string[] = [];
            let score = 0;
            for (const marker of definition.markers) {
                const hit = useFrom(candidates).filter(file => markerMatches(marker, file)).toCollectable().findFirst();
                if (hit.isEmpty()) continue;
                matched.push(marker);
                evidence.push(hit.get());
                score += marker.weight;
            }
            if (score === 0) continue;
            detections.push(Object.freeze({
                serie: definition,
                score,
                matched: Object.freeze(matched),
                evidence: Object.freeze(evidence),
            }));
        }
        detections.sort(compareDetections);
        return Object.freeze(detections.slice(0, limit));
    }

    /** Best detection, or an empty Optional when no definition matches. */
    best(files: readonly string[]): Optional<SerieDetection> {
        return Optional.ofNullable<SerieDetection>(this.detect(files)[0]);
    }
}
