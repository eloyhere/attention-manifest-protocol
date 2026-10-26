#!/usr/bin/env node
/**
 * OAuth discovery probe (RFC 9728 protected-resource metadata, RFC 8414 AS metadata).
 * We cannot complete a user-authorization flow headlessly; this verifies the chain
 * AMP's client would have to follow, and what it must implement (CIMD, resource id).
 */

/**
 * Metadata fields the probe reads from a discovery document.
 */
type DiscoveryMetadata = {
    resource?: string;
    authorization_servers?: string[];
    scopes_supported?: string[];
    signed_metadata?: string;
    issuer?: string;
    registration_endpoint?: string;
    token_endpoint?: string;
    client_id_metadata_document_supported?: boolean;
    code_challenge_methods_supported?: string[];
};

/**
 * Result of an MCP `initialize` request.
 */
type InitializeResponse = {
    status: number;
    authenticate: string | null;
    body: string;
};

/**
 * Result of a discovery document request.
 */
type JsonResponse = {
    status: number;
    json?: DiscoveryMetadata;
    text?: string;
};

const Targets: string[] = ["https://mcp.linear.app/mcp", "https://mcp.figma.com/mcp"];

/**
 * Send an `initialize` request and capture the status and challenge header.
 */
const post: (url: string) => Promise<InitializeResponse> = async (url: string): Promise<InitializeResponse> => {
    const res: Response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "amp-probe", version: "0.1.0" } },
        }),
        signal: AbortSignal.timeout(15_000),
    });
    return { status: res.status, authenticate: res.headers.get("www-authenticate"), body: (await res.text()).slice(0, 160) };
};

/**
 * Fetch a discovery document, keeping the status when the body is not JSON.
 */
const getJson: (url: string) => Promise<JsonResponse> = async (url: string): Promise<JsonResponse> => {
    const res: Response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
    const text: string = await res.text();
    try {
        return { status: res.status, json: JSON.parse(text) };
    } catch {
        return { status: res.status, text: text.slice(0, 160) };
    }
};

for (let i: number = 0; i < Targets.length; i += 1) {
    const url: string = Targets[i];
    console.log(`\n=== ${url}`);
    const init: InitializeResponse = await post(url);
    console.log(`initialize: HTTP ${init.status}`);
    console.log(`www-authenticate: ${init.authenticate ?? "(none)"}`);

    const match: RegExpMatchArray = init.authenticate?.match(/resource_metadata="([^"]+)"/);
    if (!match) {
        console.log("no resource_metadata pointer; cannot continue discovery");
        continue;
    }

    const prm: JsonResponse = await getJson(match[1]);
    console.log(`PRM: HTTP ${prm.status}`);
    console.log(`  resource: ${prm.json?.resource}`);
    console.log(`  authorization_servers: ${JSON.stringify(prm.json?.authorization_servers)}`);
    console.log(`  scopes_supported: ${JSON.stringify(prm.json?.scopes_supported ?? [])}`);
    console.log(`  signed_metadata present: ${Boolean(prm.json?.signed_metadata)}`);

    const asUrl: string = prm.json?.authorization_servers?.[0];
    if (!asUrl) {
        continue;
    }

    const candidates: string[] = [
        `${asUrl.replace(/\/$/, "")}/.well-known/oauth-authorization-server`,
        `${asUrl.replace(/\/$/, "")}/.well-known/openid-configuration`,
    ];
    for (let j: number = 0; j < candidates.length; j += 1) {
        const candidate: string = candidates[j];
        const asMetadata: JsonResponse = await getJson(candidate);
        if (asMetadata.status !== 200) {
            continue;
        }
        console.log(`AS metadata (${candidate}): HTTP ${asMetadata.status}`);
        console.log(`  issuer: ${asMetadata.json?.issuer}`);
        console.log(`  registration_endpoint: ${asMetadata.json?.registration_endpoint ?? "(none)"}`);
        console.log(`  token_endpoint: ${asMetadata.json?.token_endpoint ?? "(none)"}`);
        console.log(`  client_id_metadata_document_supported: ${asMetadata.json?.client_id_metadata_document_supported ?? "(absent)"}`);
        console.log(`  code_challenge_methods_supported: ${JSON.stringify(asMetadata.json?.code_challenge_methods_supported ?? [])}`);
        break;
    }
}
