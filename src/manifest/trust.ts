import type { AgentCard, CardResult } from "./agentCard.ts";
import { fetchAgentCard } from "./agentCard.ts";
import type { CardSignature } from "./cardSign.ts";
import { verifyCardWithRegistry } from "./cardSign.ts";
import { registryFromBundle } from "./federation.ts";
import { verifyAttestationWithKey } from "./federation.ts";
import type { Attestation, ManifestBundle } from "./federationTypes.ts";
import type { Timestamp } from "../types/common.ts";
import type { KeyRegistry, VerifyResult } from "./sign.ts";

export interface TrustPolicy {
    /**
     * Scopes an attestation must carry before the card is usable.
     */
    requiredScopes: string[];
}

export interface TrustResult {
    ok: boolean;
    reasons: string[];
    scopes: string[];
    endpoint?: string;
}

interface TrustCardInput {
    card: AgentCard;
    signature: CardSignature;
    bundle: ManifestBundle;
    policy: TrustPolicy;
    issuerKeys?: KeyRegistry;
    /**
     * Verification time. Defaults to the real clock.
     */
    now?: Timestamp;
}

interface FetchTrustedOptions {
    bundle: ManifestBundle;
    policy: TrustPolicy;
    issuerKeys?: KeyRegistry;
    timeoutMs?: number;
    /**
     * Verification time. Defaults to the real clock.
     */
    now?: Timestamp;
}

type TrustedAgentResult = TrustResult & {
    card?: AgentCard;
};

type SignedAgentCard = AgentCard & {
    signatures?: CardSignature[];
};

type TrustCardFn = (input: TrustCardInput) => Promise<TrustResult>;

type FetchTrustedAgentFn = (baseUrl: string, options: FetchTrustedOptions) => Promise<TrustedAgentResult>;

/**
 * The policy gate: keys come from the bundle, endorsement comes from
 * attestations bound to the manifest digest, and required scopes must be
 * signed by an issuer key the caller already trusts.
 */
export const trustCard: TrustCardFn = async (input: TrustCardInput): Promise<TrustResult> => {
    const reasons: string[] = [];
    const registry: KeyRegistry = await registryFromBundle(input.bundle);
    const cardVerdict: VerifyResult = await verifyCardWithRegistry(input.card, input.signature, registry);
    reasons.push(...cardVerdict.reasons);
    const now: number = Date.parse(input.now ?? new Date().toISOString());
    if (!Number.isFinite(now)) {
        reasons.push("now is not a valid timestamp");
    }
    const skew: number = 5 * 60_000;

    const scopes: Set<string> = new Set<string>();
    const attestations: Attestation[] = input.bundle.attestations ?? [];
    for (let attestationIndex: number = 0; attestationIndex < attestations.length; attestationIndex += 1) {
        const attestation: Attestation = attestations[attestationIndex];
        if (attestation.subject.digest !== input.bundle.manifest.digest) {
            reasons.push(`attestation ${attestation.id} does not bind the manifest digest`);
            continue;
        }
        const expires: number = Date.parse(attestation.expires);
        const issued: number = Date.parse(attestation.issued);
        if (!Number.isFinite(expires) || !Number.isFinite(issued)) {
            reasons.push(`attestation ${attestation.id}: invalid validity window`);
            continue;
        }
        if (expires + skew < now) {
            reasons.push(`attestation ${attestation.id}: expired`);
            continue;
        }
        if (issued - skew > now) {
            reasons.push(`attestation ${attestation.id}: issued in the future`);
            continue;
        }
        const kid: string | undefined = attestation.signatures[0]?.kid;
        const issuerKey: CryptoKey | undefined = kid ? input.issuerKeys?.get(kid) : undefined;
        if (!issuerKey) {
            reasons.push(`attestation ${attestation.id}: unknown issuer key ${`${kid}`}`);
            continue;
        }
        const verdict: VerifyResult = await verifyAttestationWithKey(attestation, issuerKey);
        if (!verdict.ok) {
            reasons.push(...verdict.reasons.map((reason) => `${attestation.id}: ${reason}`));
            continue;
        }
        for (let scopeIndex: number = 0; scopeIndex < attestation.scope.length; scopeIndex += 1) {
            const scope: string = attestation.scope[scopeIndex];
            scopes.add(scope);
        }
    }

    for (let requiredIndex: number = 0; requiredIndex < input.policy.requiredScopes.length; requiredIndex += 1) {
        const required: string = input.policy.requiredScopes[requiredIndex];
        if (!scopes.has(required)) {
            reasons.push(`missing required scope: ${required}`);
        }
    }

    return { ok: reasons.length === 0, reasons, scopes: [...scopes] };
};

/**
 * Discovery + trust in one call: fetch the card, then apply the policy.
 */
export const fetchTrustedAgent: FetchTrustedAgentFn = async (baseUrl: string, options: FetchTrustedOptions): Promise<TrustedAgentResult> => {
    const discovered: CardResult = await fetchAgentCard(baseUrl, { timeoutMs: options.timeoutMs });
    if (!discovered.ok || !discovered.card) {
        return { ok: false, reasons: discovered.reasons, scopes: [] };
    }
    const signatures: CardSignature[] | undefined = (discovered.card as SignedAgentCard).signatures;
    if (!signatures?.length) {
        return { ok: false, reasons: ["card carries no signature"], scopes: [], card: discovered.card };
    }
    const verdict: TrustResult = await trustCard({
        card: discovered.card,
        signature: signatures[0],
        bundle: options.bundle,
        policy: options.policy,
        issuerKeys: options.issuerKeys,
        now: options.now,
    });
    return { ...verdict, endpoint: discovered.endpoint, card: discovered.card };
};
