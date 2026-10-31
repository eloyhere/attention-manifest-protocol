import type { DelegationDoc } from "../cooperation/collaboration.ts";
import type { Delegation } from "../delegate/team.ts";
import { toDelegationDoc } from "./wire.ts";

export interface ChannelVerdict {
    accepted: boolean;
    reason?: string;
}

export interface Channel {
    send(doc: DelegationDoc): Promise<ChannelVerdict>;
}

/**
 * Loopback channel: the peer is a policy function, not a promise.
 * It exists so the transport seam is testable before any network code lands.
 */
export class LoopbackChannel implements Channel {
    readonly sent: DelegationDoc[] = [];
    private readonly policy: (doc: DelegationDoc) => ChannelVerdict;

    constructor(policy: (doc: DelegationDoc) => ChannelVerdict = () => ({ accepted: true })) {
        this.policy = policy;
    }

    async send(doc: DelegationDoc): Promise<ChannelVerdict> {
        this.sent.push(doc);
        return this.policy(doc);
    }
}

type DelegateOver = (channel: Channel, delegation: Delegation) => Promise<DelegationDoc>;

/**
 * Sends one delegation and fails closed if the peer declines it.
 */
export const delegateOver: DelegateOver = async (channel: Channel, delegation: Delegation): Promise<DelegationDoc> => {
    const doc: DelegationDoc = toDelegationDoc(delegation);
    const verdict: ChannelVerdict = await channel.send(doc);
    if (!verdict.accepted) {
        throw new Error(`delegation rejected: ${verdict.reason ?? "no reason given"}`);
    }
    return doc;
};
