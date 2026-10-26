# Live MCP compatibility probe (2026-10-24)

Real endpoints, probed from this machine with `tools/net-probe.ts` and exercised end-to-end with `tools/live-exec.ts`.

| Endpoint | Protocol spoken | Session | `server/discover` | Notes |
| --- | --- | --- | --- | --- |
| `mcp.context7.com/mcp` | **2026-07-28** | none | ✅ | Requires `MCP-Protocol-Version`, `Mcp-Method`, and `Mcp-Name` (for tools/call). Full discover → list → call works. |
| `learn.microsoft.com/api/mcp` | 2025-06-18 | issued | `-32601` | Legacy handshake; tools/list and tools/call work with the session id. |
| `mcp.deepwiki.com/mcp` | 2025-11-25 max | none | `-32600` (unsupported version) | Explicitly rejects `2026-07-28`; lists supported versions. |
| `mcp.linear.app/mcp` | — | — | 401 | OAuth required; unauthenticated probe is meaningless. |

## What this means

1. **The zero-modification claim is now demonstrated, once.** context7 accepted the AMP client with no server change: stateless `_meta`, `server/discover`, `tools/list`, `tools/call`, result later shaped into a handle.
2. **The ecosystem is mostly behind the spec.** Two of three public servers speak 2025-06-18/2025-11-25 and do not implement `server/discover`. AMP's client therefore needs a legacy fallback (`initialize` + session header) before it can honestly claim broad interoperability.
3. **The HTTP binding is not just `_meta`.** The 2026-07-28 streamable-HTTP transport mirrors the JSON-RPC envelope into headers. Omitting them yields `-32020`, which is a protocol error, not a server bug. `HttpTransport` now sets all three.

## Live run (context7)

```
discover: versions=2026-07-28  ttlMs=3600000
tools: 2  digest=sha256:c9558660d07ea…
call: outcome=success  tokens=418  handle=h.5a846e6ae6
usage: {"tokens":0,"calls":1,"ms":900}
note: result 418 tokens > budget 300; handle emitted, nothing truncated
```

The tool result was 418 tokens against a 300-token budget. It became a handle; the first page returned 120 tokens with `next=480`. Nothing was truncated, and the receipt recorded predicted vs realized VOI.

## Legacy fallback (verified 2026-10-24)

`McpClient.negotiate()` tries `server/discover` first and falls back to `initialize` + `notifications/initialized` on any protocol error. Both legacy servers then pass the full Exec path:

| Server | Mode | Tools | Live call | Result |
| --- | --- | --- | --- | --- |
| mslearn | legacy, session issued | 3 | `microsoft_docs_search` | 6,247 tokens → handle `h.921073bb11` |
| deepwiki | legacy, no session | 3 | `read_wiki_structure` | 351 tokens → handle `h.48e9c0402e` |

The deepwiki call returned the real page index for `facebook/react`; the mslearn call returned official Azure Functions documentation. Neither server was modified.

## OAuth discovery (verified 2026-10-24)

Both unauthorized endpoints return a `WWW-Authenticate` pointer; the client must follow it rather than guess a well-known path.

| | Linear | Figma |
| --- | --- | --- |
| `WWW-Authenticate` | `resource_metadata="…/.well-known/oauth-protected-resource/mcp"`, scope `read write` | `resource_metadata="…/.well-known/oauth-protected-resource"`, scope `mcp:connect` |
| PRM `resource` | `https://mcp.linear.app/mcp` (exact match) | `https://mcp.figma.com/mcp` |
| Authorization server | `https://mcp.linear.app` | `https://api.figma.com` |
| Registration | `…/register` **and** CIMD supported | `…/v1/oauth/mcp/register`, CIMD absent |
| PKCE | S256 | S256 |
| `signed_metadata` | absent | absent |

Three design rules fall out:

1. **Use the pointer, not a convention.** Figma's PRM lives at `/.well-known/oauth-protected-resource` (no `/mcp` suffix) while Linear's is at `…/oauth-protected-resource/mcp`. A hardcoded path works for one and breaks the other.
2. **Prefer CIMD where advertised, fall back to DCR.** Linear advertises `client_id_metadata_document_supported: true`; Figma does not, so it still needs dynamic registration. A client that only implements DCR is functional but already legacy.
3. **Echo the resource.** The PRM's `resource` must equal the endpoint actually contacted (RFC 8707), and the token request must carry it. Neither server returns `signed_metadata` today — AMP's signing story is additive, not duplicative.

What remains unimplemented is the interactive part: browser authorization, token storage, and injecting the access token at the transport boundary. That needs a human in the loop and a credential vault, so it is deliberately outside the reference runtime.

## Reproduce

```bash
node tools/net-probe.ts    # probe the matrix
node tools/oauth-probe.ts  # OAuth discovery chain
npm run live-test           # Exec path against context7 (2026-07-28)
npm run live-legacy         # Exec path against mslearn + deepwiki (2025-06-18)
```
