import { createHash } from "node:crypto";
import { isObject, SynchronousOrderedMap, useFrom } from "semantic-typescript";
import type { Optional } from "semantic-typescript";
import { WorkspaceError } from "../workspace/types.ts";
import {
    describeEnvironment as renderEnvironment, emptyEnvironment, mergeEnvironment, planEnvironment, validateEnvironment,
    type EnvironmentPatch, type EnvironmentPlan, type ProjectEnvironment,
} from "./environment.ts";
import type { ProjectMetadata, ProjectOptions, ProjectRule, ProjectRuleInput, ProjectScope, ProjectView, ViewKind } from "./types.ts";

const clone = <T>(value: T): T => isObject(value) ? structuredClone(value) as T : value;
const nowIso = (): string => new Date().toISOString();

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

    constructor(options: ProjectOptions) {
        if (!options.tenantId || !options.rootId) throw new WorkspaceError("invalid_project", "tenantId and rootId are required");
        this.tenantId = options.tenantId;
        this.rootId = options.rootId;
        this.clock = options.clock ?? nowIso;
        this.kindId = options.kind;
        this.extraGuidance = Object.freeze([...(options.guidance ?? [])]);
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
        this.views.put(input.kind, clone(view));
        return clone(view);
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

export type { ProjectMetadata, ProjectOptions, ProjectRule, ProjectRuleInput, ProjectScope, ProjectView, ViewKind } from "./types.ts";
export type { WorkspaceError } from "../workspace/types.ts";
