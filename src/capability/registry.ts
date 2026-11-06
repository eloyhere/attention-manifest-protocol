import { Optional, SynchronousUnorderedMap, SynchronousUnorderedSet, isString, useFrom } from "semantic-typescript";
import type { Identifier } from "../shared.ts";
import type { CapabilityActivation, CapabilityDefinition, CapabilityQuery, DependencyResolution, Clock } from "./types.ts";

const clone = <T>(value: T): T => structuredClone(value);
const keyOf = (id: Identifier, version: string): string => `${id}@${version}`;

/** Host-neutral, versioned capability definitions and activations. Memory only; persistence belongs to the host. */
export class CapabilityRegistry {
    private readonly definitions = new SynchronousUnorderedMap<string, CapabilityDefinition>();
    private readonly activations = new SynchronousUnorderedMap<string, CapabilityActivation>();
    private readonly activationOrder = new SynchronousUnorderedMap<string, number>();
    private readonly invalidatedVersions = new SynchronousUnorderedSet<string>();
    private readonly clock: Clock;
    private activationSequence = 0;
    constructor(clock: Clock = () => new Date().toISOString()) { this.clock = clock; }

    define(definition: CapabilityDefinition): CapabilityDefinition {
        if (!isString(definition.id) || !definition.id || !isString(definition.version) || !definition.version || !isString(definition.digest) || !definition.digest) throw new TypeError("Capability definition requires id, version and digest");
        const key = keyOf(definition.id, definition.version);
        if (this.definitions.containsKey(key)) throw new TypeError(`Capability already defined: ${key}`);
        this.definitions.put(key, clone(definition));
        return clone(definition);
    }
    get(id: Identifier, version: string): CapabilityDefinition | undefined {
        const value = this.find(id, version); return value.isPresent() ? clone(value.get()) : undefined;
    }
    find(id: Identifier, version: string): Optional<CapabilityDefinition> {
        return this.definitions.get(keyOf(id, version)).map(clone);
    }
    list(query: CapabilityQuery = {}): readonly CapabilityDefinition[] {
        return Object.freeze(useFrom(this.definitions.values().toArray()).filter(value =>
            (query.kind === undefined || value.kind === query.kind) && (query.id === undefined || value.id === query.id)
            && (!query.usableOnly || this.latestUsable(value.id) !== undefined)).map(clone).toCollectable().toArray());
    }
    activate(id: Identifier, version: string): CapabilityActivation {
        const definition = this.get(id, version); if (!definition) throw new TypeError(`Unknown capability: ${id}@${version}`);
        const dependencies = definition.dependencies.map((dependency): DependencyResolution => {
            const primaryKey = keyOf(dependency.capabilityId, dependency.version);
            if (this.get(dependency.capabilityId, dependency.version) && !this.invalidatedVersions.contains(primaryKey)) return { capabilityId: dependency.capabilityId, version: dependency.version, status: "available", required: dependency.required, resolvedCapabilityId: dependency.capabilityId, resolvedVersion: dependency.version };
            const fallback = dependency.fallback;
            if (fallback && this.get(fallback.capabilityId, fallback.version) && !this.invalidatedVersions.contains(keyOf(fallback.capabilityId, fallback.version))) return { capabilityId: dependency.capabilityId, version: dependency.version, status: "fallback", required: dependency.required, resolvedCapabilityId: fallback.capabilityId, resolvedVersion: fallback.version };
            return { capabilityId: dependency.capabilityId, version: dependency.version, status: dependency.required ? "missing" : "invalid", required: dependency.required };
        });
        const failed = this.invalidatedVersions.contains(keyOf(id, version)) || dependencies.some(item => item.required && item.status === "missing");
        const activation: CapabilityActivation = { activationId: `${id}@${version}#${++this.activationSequence}`, capabilityId: id, version, status: failed ? "failed" : dependencies.some(item => item.status === "fallback") ? "degraded" : "active", activatedAt: this.clock(), dependencies, ...(failed ? { reason: "required dependency unavailable" } : {}) };
        this.activations.put(activation.activationId, clone(activation)); this.activationOrder.put(activation.activationId, this.activationSequence); return clone(activation);
    }
    invalidate(activationId: Identifier, reason: string): CapabilityActivation {
        const value = this.findActivation(activationId); if (value.isEmpty()) throw new TypeError(`Unknown activation: ${activationId}`);
        const current = value.get(); this.invalidatedVersions.add(keyOf(current.capabilityId, current.version));
        const updated = { ...current, status: "revoked" as const, invalidatedAt: this.clock(), reason }; this.activations.put(activationId, clone(updated));
        this.invalidateDependents(current.capabilityId, current.version, reason); return clone(updated);
    }
    findActivation(activationId: Identifier): Optional<CapabilityActivation> { return this.activations.get(activationId).map(clone); }
    getActivation(activationId: Identifier): CapabilityActivation | undefined { const value = this.findActivation(activationId); return value.isPresent() ? clone(value.get()) : undefined; }
    latestUsable(id: Identifier): CapabilityActivation | undefined {
        let latest: CapabilityActivation | undefined;
        for (const activation of this.activations.values()) if (activation.capabilityId === id && !this.invalidatedVersions.contains(keyOf(id, activation.version)) && ["active", "degraded"].includes(activation.status) && (!latest || (this.activationOrder.get(activation.activationId).orElse(-1) as number) > (this.activationOrder.get(latest.activationId).orElse(-1) as number))) latest = activation;
        return latest ? clone(latest) : undefined;
    }
    private invalidateDependents(capabilityId: Identifier, version: string, reason: string): void {
        for (const activation of this.activations.values().toArray()) {
            if (activation.dependencies.some(dependency => (dependency.resolvedCapabilityId ?? dependency.capabilityId) === capabilityId && (dependency.resolvedVersion ?? dependency.version) === version) && ["active", "degraded"].includes(activation.status)) {
                const updated = { ...activation, status: "failed" as const, invalidatedAt: this.clock(), reason: `dependency invalidated: ${reason}` }; this.activations.put(activation.activationId, clone(updated)); this.invalidatedVersions.add(keyOf(activation.capabilityId, activation.version)); this.invalidateDependents(activation.capabilityId, activation.version, reason);
            }
        }
    }
}
