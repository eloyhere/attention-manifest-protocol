/**
 * Safety escalation/handoff sink.
 *
 * The runtime does not try to be a crisis service. It records a minimal event
 * (no full user text) and returns resources; a human/ops adapter can page.
 */
export interface EscalationEvent {
    id: string;
    turnId: string;
    at: string;
    reason: string;
    resources: string[];
}

export interface EscalationSink {
    escalate(event: Omit<EscalationEvent, "id">): string;
}

export const CrisisResources = [
    "Local emergency services (e.g. 120/911) if there is immediate danger.",
    "A trusted person who can stay with the user.",
    "A local crisis line; in the US, 988.",
];

export class MemoryEscalationSink implements EscalationSink {
    readonly events: EscalationEvent[] = [];
    private counter = 0;

    escalate(event: Omit<EscalationEvent, "id">): string {
        this.counter += 1;
        const id = `esc.${this.counter}`;
        this.events.push({ id, ...event });
        return id;
    }
}
