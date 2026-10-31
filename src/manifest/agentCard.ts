/**
 * A2A v1.0 Agent Card discovery.
 */

export interface AgentInterface {
    url: string;
    protocolBinding?: string;
    protocolVersion?: string;
}

export interface AgentCard {
    name: string;
    description?: string;
    version?: string;
    url?: string;
    supportedInterfaces?: AgentInterface[];
    capabilities?: Record<string, unknown>;
    skills?: Array<{
        id: string;
        name?: string;
    }>;
}

export interface CardResult {
    ok: boolean;
    card?: AgentCard;
    endpoint?: string;
    reasons: string[];
}

type CardOptions = {
    timeoutMs?: number;
};

type FetchAgentCard = (baseUrl: string, options?: CardOptions) => Promise<CardResult>;

const WellKnown: string = "/.well-known/agent-card.json";

/**
 * Fetches and minimally validates an Agent Card; the endpoint is derived from it.
 */
export const fetchAgentCard: FetchAgentCard = async (baseUrl: string, options: CardOptions = {}): Promise<CardResult> => {
    const url: string = `${baseUrl.replace(/\/$/, "")}${WellKnown}`;
    const controller: AbortController = new AbortController();
    const timer: ReturnType<typeof setTimeout> = setTimeout(() => controller.abort(), options.timeoutMs ?? 5_000);
    try {
        const response: Response = await fetch(url, {
            headers: { accept: "application/json", "a2a-version": "1.0" },
            signal: controller.signal,
        });
        if (!response.ok) {
            return { ok: false, reasons: [`HTTP ${response.status} from ${url}`] };
        }

        const card: AgentCard = (await response.json()) as AgentCard;
        const reasons: string[] = [];
        if (typeof(card?.name) !== "string" || card.name.length === 0) {
            reasons.push("card has no name");
        }
        if (!card?.url && !(card?.supportedInterfaces?.length ?? 0)) {
            reasons.push("card has no interface url");
        }

        const endpoint: string | undefined = card?.url ?? card?.supportedInterfaces?.[0]?.url;
        return reasons.length === 0 && endpoint ? { ok: true, card, endpoint, reasons } : { ok: false, card, reasons };
    } catch (error) {
        const reason: string = error instanceof Error && error.name === "AbortError" ? "timeout" : `${error}`;
        return { ok: false, reasons: [reason] };
    } finally {
        clearTimeout(timer);
    }
};
