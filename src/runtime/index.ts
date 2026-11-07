export { LcpService } from "./lcp.ts";
export type { LcpHost } from "./lcp.ts";
import { Optional, SynchronousUnorderedMap } from "semantic-typescript";
import { EvidenceLedger, createInvocation, createObservation, createReceiptCore, verifyBusinessSemantics, verifyReceiptIntegrity } from "../provenance.ts";
import { digestOf } from "../serialization/index.ts";
import type { BusinessVerification, ReceiptCore, ReceiptIntegrityVerification } from "../provenance.ts";
import type { ExecutionContext, InvocationRecord, ObservationRecord } from "../shared.ts";
import type { Executor, RunResult, ChildCall } from "../tooling.ts";
import type { JsonValue } from "../shared.ts";
import type { Acceptance } from "../workflow.ts";

/** Host-provided, versioned business assertions; a successful tool call is not sufficient. */
export interface VerificationContract {
    version: string;
    environmentVersion: string;
    claims: readonly string[];
    evaluate: (observation: ObservationRecord) => boolean | Promise<boolean>;
}

export interface VerifiedExecution {
    execution: RunResult;
    receipts: readonly ReceiptCore[];
    integrity: readonly ReceiptIntegrityVerification[];
    verification: readonly BusinessVerification[];
    evidenceIds: readonly string[];
    acceptance?: Acceptance;
}

export interface ReceiptSink {
    /** Implementations must persist before acknowledging success. */
    append(receipt: ReceiptCore): void | Promise<void>;
}

export class MemoryReceiptSink implements ReceiptSink {
    private readonly records = new SynchronousUnorderedMap<string, ReceiptCore>();
    append(receipt: ReceiptCore): void {
        if (this.records.containsKey(receipt.id)) {
            throw new Error(`Duplicate receipt: ${receipt.id}`);
        }
        this.records.put(receipt.id, receipt);
    }
    find(id: string): Optional<ReceiptCore> { return this.records.get(id); }
    list(): readonly ReceiptCore[] { return this.records.values().toArray(); }
}

/** Hash scope is exactly the immutable invocation and observation encoded below. */
export const executionFactDigest = (invocation: InvocationRecord, observation: ObservationRecord): string => {
    return digestOf({ invocation, observation });
};

/**
 * Connects LCP child observations to independent L6 verification and L7 evidence.
 * It does not run generated code, grant authority or own WorkflowStore transitions.
 * Executor, receipt durability, signatures and verifier authority are host ports.
 */
export class ExecutionCoordinator {
    private readonly executor: Executor<JsonValue, JsonValue>;
    private readonly evidence: EvidenceLedger;
    private readonly receipts: ReceiptSink;
    private readonly clock: () => string;

    constructor(options: { executor: Executor<JsonValue, JsonValue>; evidence: EvidenceLedger; receipts: ReceiptSink; clock?: () => string }) {
        this.executor = options.executor;
        this.evidence = options.evidence;
        this.receipts = options.receipts;
        this.clock = options.clock ?? (() => new Date().toISOString());
    }

    async execute(calls: readonly ChildCall[], context: ExecutionContext, budgetKey: string, contract: VerificationContract): Promise<VerifiedExecution> {
        if (!contract.version || !contract.environmentVersion || contract.claims.length === 0) {
            throw new Error("A versioned business contract with claims is required");
        }
        const execution = await this.executor.run(calls, context, budgetKey);
        const receipts: ReceiptCore[] = [];
        const integrityRecords: ReceiptIntegrityVerification[] = [];
        const verifications: BusinessVerification[] = [];
        const evidenceIds: string[] = [];
        for (const child of execution.children) {
            const invocation = createInvocation(child.invocation);
            const observation = createObservation(child.observation);
            const receipt = createReceiptCore({
                id: `receipt:${invocation.id}`, invocation, observation,
                issuedAt: this.clock(), hashAlgorithm: "sha256-json-execution-facts/1",
                payloadDigest: executionFactDigest(invocation, observation),
            });
            await this.receipts.append(receipt);
            receipts.push(receipt);
            const integrity = await verifyReceiptIntegrity(receipt, {
                digest: value => executionFactDigest(value.invocation, value.observation),
                verifier: "execution-facts/1", verifiedAt: this.clock(),
            });
            integrityRecords.push(integrity);
            const verification = await verifyBusinessSemantics(receipt, integrity, {
                id: `verification:${invocation.id}`, criteriaVersion: contract.version,
                verifier: "host-business-contract", verifiedAt: this.clock(),
            }, async value => value.status === "success" && await contract.evaluate(value), contract.claims);
            verifications.push(verification);
            if (verification.status === "semantic_verified") {
                for (const [index, claim] of contract.claims.entries()) {
                    const item = this.evidence.add({
                        id: `evidence:${invocation.id}:${index}`, tenantId: context.tenantId,
                        claim, polarity: "supports", receipt, integrity, verification,
                        criteriaVersion: contract.version, environmentVersion: contract.environmentVersion,
                        createdAt: this.clock(),
                    });
                    evidenceIds.push(item.id);
                }
            }
        }
        const accepted = execution.completed && calls.length > 0 && verifications.length === calls.length
            && verifications.every(item => item.status === "semantic_verified");
        return {
            execution, receipts, integrity: integrityRecords, verification: verifications, evidenceIds,
            ...(accepted ? { acceptance: {
                contractVersion: contract.version, valid: true,
                verificationId: verifications[verifications.length - 1].id, evidenceIds,
            } } : {}),
        };
    }
}
