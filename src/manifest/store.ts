import { Optional, SynchronousOrderedMap, SynchronousUnorderedSet } from "semantic-typescript";
import { safeStringify } from "../serialization/index.ts";
import type { Identifier } from "../shared.ts";
import type { Manifest, ToolDefinition, ToolHandle } from "../tool/types.ts";

export type ManifestKey = {
    readonly tenantId: Identifier;
    readonly endpointId: Identifier;
    readonly version: string;
    readonly digest: string;
    readonly policyScope: string;
};

function keyOf(key: ManifestKey): string {
    return safeStringify([key.tenantId, key.endpointId, key.version, key.digest, key.policyScope]);
}

function validDate(value: string, field: string): number {
    const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
    if (!Number.isFinite(parsed)) throw new Error(`Invalid manifest ${field}.`);
    return parsed;
}

function requireText(value: unknown, field: string): void {
    if (typeof value !== "string" || value.trim() === "") throw new Error(`Manifest ${field} is required.`);
}

function validateIdentityAndVersion<Schema>(manifest: Manifest<Schema>): void {
    // These fields participate in the manifest/handle identity or version pin;
    // accepting an empty value would create an unaddressable or unpinned entry.
    for (const field of ["manifestId", "tenantId", "endpointId", "endpointIdentity", "serverVersion", "digest", "policyScope"] as const) {
        requireText(manifest[field], field);
    }
    for (const tool of manifest.tools) {
        requireText(tool.toolId, "toolId");
        requireText(tool.version, "toolVersion");
        requireText(tool.digest, "toolDigest");
        requireText(tool.policyScope, "toolPolicyScope");
    }
}

function contentOf<Schema>(manifest: Manifest<Schema>): string {
    // Immutability is about content, not about the order a caller happened to
    // build the object in; stable keys make the comparison order-insensitive.
    return safeStringify(manifest, { stableKeys: true });
}

export class ManifestStore<Schema = import("../shared.ts").JsonValue> {
    private readonly manifests = new SynchronousOrderedMap<string, Manifest<Schema>>();
    private readonly revoked = new SynchronousUnorderedSet<string>();
    private readonly now: () => string;

    constructor(now: () => string = () => new Date().toISOString()) {
        this.now = now;
    }

    put(manifest: Manifest<Schema>): void {
        validateIdentityAndVersion(manifest);
        validDate(manifest.issuedAt, "issuedAt");
        if (manifest.expiresAt !== undefined) {
            const issued = Date.parse(manifest.issuedAt);
            const expires = validDate(manifest.expiresAt, "expiresAt");
            if (expires < issued) throw new Error("Manifest expiresAt precedes issuedAt.");
        }
        const uniqueTools = new SynchronousUnorderedSet<string>();
        for (const tool of manifest.tools) {
            if (uniqueTools.contains(tool.toolId)) throw new Error(`Duplicate tool id ${tool.toolId} in manifest.`);
            uniqueTools.add(tool.toolId);
        }
        const key = keyOf({
            tenantId: manifest.tenantId,
            endpointId: manifest.endpointId,
            version: manifest.serverVersion,
            digest: manifest.digest,
            policyScope: manifest.policyScope,
        });
        const existing = this.manifests.get(key);
        if (existing.isPresent() && contentOf(existing.get()) !== contentOf(manifest)) {
            throw new Error(`Manifest key ${key} is immutable and already has different content.`);
        }
        this.manifests.put(key, structuredClone(manifest));
    }

    revoke(key: ManifestKey): void {
        this.revoked.add(keyOf(key));
    }

    unrevoke(key: ManifestKey): void {
        this.revoked.remove(keyOf(key));
    }

    isRevoked(key: ManifestKey): boolean {
        return this.revoked.contains(keyOf(key));
    }

    findManifest(key: ManifestKey) {
        const encoded = keyOf(key);
        if (this.revoked.contains(encoded)) return Optional.empty<Manifest<Schema>>();
        const stored = this.manifests.get(encoded);
        if (stored.isEmpty()) return Optional.empty<Manifest<Schema>>();
        const manifest = stored.get();
        if (this.expired(manifest)) return Optional.empty<Manifest<Schema>>();
        return Optional.of(structuredClone(manifest));
    }

    /** Expiry is inclusive: `now === expiresAt` is already expired. */
    private expired(manifest: Manifest<Schema>): boolean {
        if (manifest.expiresAt === undefined) return false;
        return Date.parse(manifest.expiresAt) <= validDate(this.now(), "now");
    }

    get(key: ManifestKey): Manifest<Schema> | undefined {
        const found = this.findManifest(key);
        return found.isPresent() ? found.get() : undefined;
    }

    findTool(handle: ToolHandle) {
        const key = {
            tenantId: handle.tenantId,
            endpointId: handle.endpointId,
            version: handle.version,
            digest: handle.digest,
            policyScope: handle.policyScope,
        };
        const manifest = this.findManifest(key);
        return manifest.flatMap((value) => {
            const tool = value.tools.find((candidate) => candidate.toolId === handle.toolId
                && (handle.toolVersion === undefined || candidate.version === handle.toolVersion)
                && (handle.toolDigest === undefined || candidate.digest === handle.toolDigest));
            return Optional.ofNullable(tool);
        });
    }

    resolveTool(handle: ToolHandle): ToolDefinition<Schema> | undefined {
        const found = this.findTool(handle);
        return found.isPresent() ? found.get() : undefined;
    }

    createHandle(manifest: Manifest<Schema>, toolId: Identifier): ToolHandle | undefined {
        const tool = manifest.tools.find((candidate) => candidate.toolId === toolId);
        if (!tool) return undefined;
        return {
            kind: "tool",
            tenantId: manifest.tenantId,
            endpointId: manifest.endpointId,
            toolId: tool.toolId,
            version: manifest.serverVersion,
            digest: manifest.digest,
            toolVersion: tool.version,
            toolDigest: tool.digest,
            policyScope: manifest.policyScope,
        };
    }
}
