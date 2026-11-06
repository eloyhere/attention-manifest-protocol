import type { AuthorizationRequest, PolicyDecision, PolicyDecisionPoint, PolicyEnforcementPoint } from "../tool/types.ts";

export class PolicyDeniedError extends Error {
    readonly decision: PolicyDecision;
    constructor(decision: PolicyDecision) {
        super(decision.reason || "Policy denied the operation.");
        this.name = "PolicyDeniedError";
        this.decision = decision;
    }
}

export class DefaultPolicyEnforcementPoint implements PolicyEnforcementPoint {
    private readonly pdp: PolicyDecisionPoint;
    constructor(pdp: PolicyDecisionPoint) {
        this.pdp = pdp;
    }

    async authorize(request: AuthorizationRequest): Promise<PolicyDecision> {
        const decision = await this.pdp(request);
        if (!decision.allowed || decision.approvalRequired === true || decision.policyVersion !== request.context.policyVersion) {
            throw new PolicyDeniedError(decision);
        }
        return decision;
    }
}
