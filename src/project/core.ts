import { createHash } from "node:crypto";
import { isObject, SynchronousOrderedMap, useFrom } from "semantic-typescript";
import type { Optional } from "semantic-typescript";
import { WorkspaceError } from "../workspace/types.ts";
import {
    describeEnvironment as renderEnvironment, emptyEnvironment, mergeEnvironment, planEnvironment, validateEnvironment,
    type EnvironmentPatch, type EnvironmentPlan, type ProjectEnvironment,
} from "./environment.ts";
import type { ProjectMetadata, ProjectOptions, ProjectRule, ProjectRuleInput, ProjectScope, ProjectView, ViewKind, ViewPurpose, ViewValidationOptions } from "./types.ts";

const clone = <T>(value: T): T => isObject(value) ? structuredClone(value) as T : value;
const nowIso = (): string => new Date().toISOString();

const VIEW_PURPOSES: readonly ViewPurpose[] = Object.freeze(["routing", "verification", "planning", "diagnosis", "retention"]);
const VIEW_KINDS: readonly ViewKind[] = Object.freeze(["er", "sequence", "flow", "venn", "architecture", "mindmap"]);

function requireViewPurpose(value: unknown): asserts value is ViewPurpose {
    if (typeof value !== "string" || !VIEW_PURPOSES.includes(value as ViewPurpose)) {
        throw new WorkspaceError("invalid_project", `view purpose must be one of ${VIEW_PURPOSES.join(", ")}`);
    }
}

function requireViewKind(value: unknown): asserts value is ViewKind {
    if (typeof value !== "string" || !VIEW_KINDS.includes(value as ViewKind)) {
        throw new WorkspaceError("invalid_project", `view kind must be one of ${VIEW_KINDS.join(", ")}`);
    }
}

function requireFreshness(value: unknown): asserts value is number {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
        throw new WorkspaceError("invalid_project", "view freshness must be a number between 0 and 1");
    }
}

function requireStringList(value: unknown, label: string): asserts value is readonly string[] {
    if (!Array.isArray(value) || value.some(item => typeof item !== "string" || item.trim() === "")) {
        throw new WorkspaceError("invalid_project", `${label} must be an array of non-empty strings`);
    }
}

function requireNonEmptyText(value: unknown, label: string): asserts value is string {
    if (typeof value !== "string" || value.trim() === "") {
        throw new WorkspaceError("invalid_project", `${label} must be nonempty text`);
    }
}

function requireViewVersion(value: unknown, label: string): asserts value is number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
        throw new WorkspaceError("invalid_project", `${label} must be a positive safe integer`);
    }
}

function requireSourceVersions(value: unknown): asserts value is readonly { readonly ruleId: string; readonly version: number }[] {
    if (!Array.isArray(value)) throw new WorkspaceError("invalid_project", "view sourceVersions must be an array");
    for (const entry of value) {
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
            throw new WorkspaceError("invalid_project", "view sourceVersions entries must be objects");
        }
        const record = entry as { readonly ruleId?: unknown; readonly version?: unknown };
        requireNonEmptyText(record.ruleId, "view source version ruleId");
        requireViewVersion(record.version, "view source version");
    }
}

function resolveAnchorChecks(options: ViewValidationOptions): readonly ((anchor: string) => boolean)[] {
    const checks: ((anchor: string) => boolean)[] = [];
    if (options.anchorExists) checks.push(options.anchorExists);
    if (options.knownAnchors) {
        const known = new Set(options.knownAnchors);
        checks.push(anchor => known.has(anchor));
    }
    return checks;
}

function validateViewContract(view: ProjectView, options: ViewValidationOptions = {}): void {
    if (!isObject(view)) throw new WorkspaceError("invalid_project", "view must be an object");
    requireViewKind(view.kind);
    if (!Object.prototype.hasOwnProperty.call(view, "projection")) {
        throw new WorkspaceError("invalid_project", "view projection is required");
    }
    requireNonEmptyText(view.tenantId, "view tenantId");
    requireNonEmptyText(view.rootId, "view rootId");
    requireViewVersion(view.version, "view version");
    if (typeof view.stale !== "boolean") throw new WorkspaceError("invalid_project", "view stale must be a boolean");
    requireNonEmptyText(view.updatedAt, "view updatedAt");
    requireStringList(view.sourceRuleIds, "view sourceRuleIds");
    requireSourceVersions(view.sourceVersions);
    if (view.purpose !== undefined) requireViewPurpose(view.purpose);
    if (view.freshness !== undefined) requireFreshness(view.freshness);
    if (view.anchors !== undefined) requireStringList(view.anchors, "view anchors");
    if (view.constraints !== undefined) requireStringList(view.constraints, "view constraints");

    if (view.anchors !== undefined) {
        const checks = resolveAnchorChecks(options);
        for (const anchor of view.anchors) {
            const exists = checks.every(check => check(anchor));
            if (!exists) throw new WorkspaceError("invalid_project", `view anchor ${anchor} does not exist`);
        }
    }
}

/**
 * Validate the deterministic view contract: identity, version/stale fields,
 * purpose, constraints, freshness in 0..1, and — when an anchor resolver is
 * supplied — that every declared anchor exists.
 */
export function validateView(view: ProjectView, options: ViewValidationOptions = {}): void {
    validateViewContract(view, options);
}

function digest(value: string): string {
    return createHash("sha256").update(value, "utf8").digest("hex");
}

function requireScope(value: ProjectScope, expected: ProjectScope): void {
    if (value.tenantId !== expected.tenantId || value.rootId !== expected.rootId) throw new WorkspaceError("invalid_scope", "tenant and root scope mismatch");
}

/** Versioned project knowledge and minimal relationship-view projections. Parsing/validation remains a host port. */
export class Project {
    readonly tenantId: string;
    readonly rootId: string;
    private readonly rules = new SynchronousOrderedMap<string, ProjectRule>();
    private readonly metadata = new SynchronousOrderedMap<string, ProjectMetadata>();
    private readonly views = new SynchronousOrderedMap<ViewKind, ProjectView>();
    private readonly clock: () => string;
    private environmentValue: ProjectEnvironment;
    private environmentVersionValue = 0;
    private readonly kindId?: string;
    private readonly extraGuidance: readonly string[];
    private readonly anchorResolver?: (anchor: string) => boolean;

    constructor(options: ProjectOptions) {
        if (!options.tenantId || !options.rootId) throw new WorkspaceError("invalid_project", "tenantId and rootId are required");
        this.tenantId = options.tenantId;
        this.rootId = options.rootId;
        this.clock = options.clock ?? nowIso;
        this.kindId = options.kind;
        this.extraGuidance = Object.freeze([...(options.guidance ?? [])]);
        this.anchorResolver = options.anchorExists;
        try {
            this.environmentValue = mergeEnvironment(emptyEnvironment(), options.environment ?? {});
        } catch (error) {
            throw new WorkspaceError("invalid_project", error instanceof Error ? error.message : String(error));
        }
    }

    /** Current project environment (frozen). */
    get environment(): ProjectEnvironment {
        return this.environmentValue;
    }

    /** Monotonic environment revision, independent of rule/view versions. */
    get environmentVersion(): number {
        return this.environmentVersionValue;
    }

    /** Project kind this environment was initialized from, when known. */
    get kind(): string | undefined {
        return this.kindId;
    }

    /**
     * Overlays variables, paths and dependencies on the current environment.
     * A variable set to "" means "declared but unset" and becomes a configuration gap.
     */
    configureEnvironment(patch: EnvironmentPatch, options: { readonly expectedVersion?: number } = {}): ProjectEnvironment {
        this.assertEnvironmentVersion(options.expectedVersion);
        let next: ProjectEnvironment;
        try {
            next = mergeEnvironment(this.environmentValue, patch);
            validateEnvironment(next);
        } catch (error) {
            throw new WorkspaceError("invalid_project", error instanceof Error ? error.message : String(error));
        }
        this.environmentValue = next;
        this.environmentVersionValue += 1;
        return next;
    }

    /** Replaces the whole environment (removing entries the new value does not declare). */
    setEnvironment(environment: ProjectEnvironment, options: { readonly expectedVersion?: number } = {}): ProjectEnvironment {
        this.assertEnvironmentVersion(options.expectedVersion);
        let next: ProjectEnvironment;
        try {
            next = mergeEnvironment(emptyEnvironment(), environment);
            validateEnvironment(next);
        } catch (error) {
            throw new WorkspaceError("invalid_project", error instanceof Error ? error.message : String(error));
        }
        this.environmentValue = next;
        this.environmentVersionValue += 1;
        return next;
    }

    /** Computes the gaps an agent must still configure, using current project metadata paths. */
    environmentPlan(): EnvironmentPlan {
        return planEnvironment(this.environmentValue, {
            ...(this.kindId === undefined ? {} : { kind: this.kindId }),
            version: this.environmentVersionValue,
            guidance: this.extraGuidance,
            presentPaths: this.metadata.keySet().toArray(),
        });
    }

    /** Agent-facing configuration brief (Markdown) for the current environment. */
    describeEnvironment(): string {
        return renderEnvironment(this.environmentPlan());
    }

    putRule(input: ProjectRuleInput): ProjectRule {
        this.assertScope(input);
        if (!input.id || !input.text) throw new WorkspaceError("invalid_project", "rule id and text are required");
        const previous = this.rules.get(input.id).orElse(undefined);
        if (previous && input.expectedVersion !== previous.version) throw new WorkspaceError("version_conflict", "rule version changed");
        if (!previous && input.expectedVersion !== undefined) throw new WorkspaceError("version_conflict", "new rule cannot carry expectedVersion");
        const rule: ProjectRule = { ...input, version: previous ? previous.version + 1 : 1, hash: digest(input.text), updatedAt: this.clock() };
        this.rules.put(rule.id, clone(rule));
        this.invalidateRule(rule.id);
        return clone(rule);
    }

    findRule(id: string): Optional<ProjectRule> {
        return this.rules.get(id).map(value => clone(value));
    }

    getRule(id: string): ProjectRule | undefined {
        return this.findRule(id).orElse(null) ?? undefined;
    }

    listRules(): ProjectRule[] {
        return this.collect(this.rules);
    }

    putMetadata(input: Omit<ProjectMetadata, "version" | "updatedAt"> & { readonly expectedVersion?: number }): ProjectMetadata {
        this.assertScope(input);
        const previous = this.metadata.get(input.path).orElse(undefined);
        if (previous && input.expectedVersion !== previous.version) throw new WorkspaceError("version_conflict", "metadata version changed");
        if (!previous && input.expectedVersion !== undefined) throw new WorkspaceError("version_conflict", "new metadata cannot carry expectedVersion");
        const metadata: ProjectMetadata = { ...input, version: previous ? previous.version + 1 : 1, updatedAt: this.clock() };
        this.metadata.put(input.path, clone(metadata));
        return clone(metadata);
    }

    getMetadata(path: string): ProjectMetadata | undefined {
        const value = this.metadata.get(path).orElse(undefined);
        return value ? clone(value) : undefined;
    }

    listMetadata(): ProjectMetadata[] {
        return this.collect(this.metadata);
    }

    putView(input: Omit<ProjectView, "version" | "updatedAt" | "stale" | "sourceVersions">): ProjectView {
        this.assertScope(input);
        requireViewKind(input.kind);
        requireStringList(input.sourceRuleIds, "view sourceRuleIds");
        const previous = this.views.get(input.kind).orElse(undefined);
        const sourceVersions = input.sourceRuleIds.map(ruleId => {
            const rule = this.rules.get(ruleId).orElse(undefined);
            if (!rule) throw new WorkspaceError("not_found", `rule ${ruleId} does not exist`);
            return { ruleId, version: rule.version };
        });
        const view: ProjectView = {
            ...input,
            sourceVersions,
            version: previous ? previous.version + 1 : 1,
            stale: false,
            updatedAt: this.clock(),
        };
        this.validateView(view);
        this.views.put(input.kind, clone(view));
        return clone(view);
    }

    /**
     * Validate a view against this project's anchor resolver. Callers can pass
     * an explicit resolver or anchor set when validating detached views.
     */
    validateView(view: ProjectView, options: ViewValidationOptions = {}): void {
        const anchorExists = options.anchorExists ?? this.anchorResolver;
        validateViewContract(view, {
            ...(anchorExists === undefined ? {} : { anchorExists }),
            ...(options.knownAnchors === undefined ? {} : { knownAnchors: options.knownAnchors }),
        });
    }

    findView(kind: ViewKind): Optional<ProjectView> {
        return this.views.get(kind).map(value => {
            const stale = value.stale || value.sourceVersions.some(source => {
                const rule = this.rules.get(source.ruleId);
                return rule.isEmpty() || rule.get().version !== source.version;
            });
            if (stale && !value.stale) this.views.put(kind, { ...value, stale: true });
            return clone(stale ? { ...value, stale: true } : value);
        });
    }

    getView(kind: ViewKind): ProjectView | undefined {
        return this.findView(kind).orElse(null) ?? undefined;
    }

    listViews(): ProjectView[] {
        return this.collect(this.views);
    }

    invalidate(kind?: ViewKind): void {
        if (kind) {
            const value = this.views.get(kind).orElse(undefined);
            if (value) this.views.put(kind, { ...value, stale: true });
            return;
        }
        this.views.forEach((key, value) => this.views.put(key, { ...value, stale: true }));
    }

    private invalidateRule(ruleId: string): void {
        this.views.forEach((kind, view) => {
            if (view.sourceRuleIds.indexOf(ruleId) >= 0) this.views.put(kind, { ...view, stale: true });
        });
    }

    private assertScope(value: ProjectScope): void {
        requireScope(value, { tenantId: this.tenantId, rootId: this.rootId });
    }

    private assertEnvironmentVersion(expected?: number): void {
        if (expected !== undefined && expected !== this.environmentVersionValue) {
            throw new WorkspaceError("version_conflict", `environment is at version ${this.environmentVersionValue}, expected ${expected}`);
        }
    }

    private collect<T>(source: SynchronousOrderedMap<string, T> | SynchronousOrderedMap<ViewKind, T>): T[] {
        return useFrom(source.values().toArray()).map(value => clone(value)).toCollectable().toArray();
    }
}

export type { ProjectMetadata, ProjectOptions, ProjectRule, ProjectRuleInput, ProjectScope, ProjectView, ViewKind, ViewPurpose, ViewValidationOptions } from "./types.ts";
export type { WorkspaceError } from "../workspace/types.ts";
