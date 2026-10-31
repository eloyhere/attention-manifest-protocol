#!/usr/bin/env node
import assert from "node:assert/strict";
import { test } from "node:test";

import { createCooperationHandler } from "../src/governance/transport.ts";
import { GovernanceKeyring, signCanonicalValue } from "../src/governance/signing.ts";
import { generateSigningKey } from "../src/manifest/sign.ts";

const Timestamp: string = "2026-10-24T10:00:00.000Z";
const Current: number = Date.parse(Timestamp);

test("invalid transport signature cannot occupy a valid nonce", async (): Promise<void> => {
    const signer = await generateSigningKey("transport.boundary");
    const keyring: GovernanceKeyring = new GovernanceKeyring();
    keyring.add("transport.boundary", signer.publicKey);
    let deliveries: number = 0;
    const bus = {
        receive: (): { ok: boolean; code: string; detail: string } => {
            deliveries += 1;
            return { ok: true, code: "delivered", detail: "accepted" };
        },
    };
    const handler = createCooperationHandler(bus as unknown as Parameters<typeof createCooperationHandler>[0], { keyring, now: () => Current });
    const message = { id: "message.boundary" };
    const auth = { signer: "transport.boundary", kid: signer.kid, timestamp: Timestamp, nonce: "nonce.boundary" };
    const signature: string = await signCanonicalValue({ message, signer: auth.signer, timestamp: auth.timestamp, nonce: auth.nonce }, signer);
    assert.equal((await handler({ message, auth: { ...auth, signature: "invalid" } })).status, 401);
    assert.equal((await handler({ message, auth: { ...auth, signature } })).status, 200);
    assert.equal((await handler({ message, auth: { ...auth, signature } })).status, 409);
    assert.equal(deliveries, 1);
});

test("invalid clock and replay configuration fail closed", async (): Promise<void> => {
    const signer = await generateSigningKey("transport.clock");
    const keyring: GovernanceKeyring = new GovernanceKeyring();
    keyring.add("transport.clock", signer.publicKey);
    const bus = {
        receive: (): never => {
            throw new Error("invalid clock must not deliver");
        },
    };
    for (const options of [{ maxSkewMs: NaN }, { maxSkewMs: Infinity }, { replayWindowMs: NaN }, { replayWindowMs: -1 }]) {
        assert.throws(() => createCooperationHandler(bus as unknown as Parameters<typeof createCooperationHandler>[0], { keyring, ...options }), RangeError);
    }
    const handler = createCooperationHandler(bus as unknown as Parameters<typeof createCooperationHandler>[0], { keyring, now: () => NaN });
    const message = { id: "message.clock" };
    const auth = { signer: "transport.clock", kid: signer.kid, timestamp: Timestamp, nonce: "nonce.clock" };
    const signature: string = await signCanonicalValue({ message, signer: auth.signer, timestamp: auth.timestamp, nonce: auth.nonce }, signer);
    assert.equal((await handler({ message, auth: { ...auth, signature } })).status, 500);
});
