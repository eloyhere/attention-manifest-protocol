import assert from "node:assert/strict";
import test from "node:test";
import { ManifestStore } from "./store.ts";
import type { ManifestKey } from "./store.ts";
import type { Manifest } from "../tool/types.ts";
import type { JsonValue } from "../shared.ts";

const now = "2026-11-06T12:00:00Z";
const expiry = "2026-11-07T12:00:00Z";
const definition = {
    toolId: "tool", version: "1", digest: "tool-digest", summary: "summary",
    inputSchema: {}, risk: "read" as const, effect: "read_only" as const, policyScope: "scope",
};
const manifest = (overrides: Partial<Manifest> = {}): Manifest => ({
    manifestId: "manifest-1", tenantId: "tenant", endpointId: "endpoint", endpointIdentity: "host:test",
    serverVersion: "1", digest: "manifest-digest", policyScope: "scope", issuedAt: now, expiresAt: expiry,
    tools: [definition], ...overrides,
});
const keyOf = (value: Manifest): ManifestKey => ({
    tenantId: value.tenantId, endpointId: value.endpointId, version: value.serverVersion,
    digest: value.digest, policyScope: value.policyScope,
});

test("manifest expiry is inclusive and shared by get and resolveTool", () => {
    const value = manifest();
    const key = keyOf(value);
    const store = new ManifestStore<JsonValue>(() => now);
    store.put(value);
    const handle = store.createHandle(value, "tool");
    assert.ok(handle);
    assert.ok(store.get(key));
    assert.equal(store.resolveTool(handle)?.toolId, "tool");

    const before = new ManifestStore<JsonValue>(() => "2026-11-07T11:59:59.999Z");
    before.put(value);
    assert.ok(before.get(key));
    assert.equal(before.resolveTool(handle)?.toolId, "tool");

    const atExpiry = new ManifestStore<JsonValue>(() => expiry);
    atExpiry.put(value);
    assert.equal(atExpiry.get(key), undefined);
    assert.equal(atExpiry.findManifest(key).isPresent(), false);
    assert.equal(atExpiry.resolveTool(handle), undefined);
});

test("manifest put rejects empty identities and invalid timestamps but stays idempotent", () => {
    const store = new ManifestStore<JsonValue>(() => now);
    for (const field of ["manifestId", "endpointId", "serverVersion", "digest"] as const) {
        assert.throws(() => store.put(manifest({ [field]: "" })), new RegExp(`${field} is required`));
        assert.throws(() => store.put(manifest({ [field]: "  " })), new RegExp(`${field} is required`));
    }
    assert.throws(() => store.put(manifest({ issuedAt: "invalid" })), /Invalid manifest issuedAt/);
    assert.throws(() => store.put(manifest({ expiresAt: "invalid" })), /Invalid manifest expiresAt/);
    assert.throws(() => store.put(manifest({ expiresAt: "2026-01-01T00:00:00Z" })), /precedes issuedAt/);

    store.put(manifest());
    store.put(manifest());
    assert.throws(() => store.put(manifest({ endpointIdentity: "changed" })), /immutable/);
});
