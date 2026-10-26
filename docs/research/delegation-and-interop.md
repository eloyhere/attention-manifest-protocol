# AMP Delegation & Interoperability Brief

2026-10-24. Labels: `[SPEC]` standards text, `[PAPER]` peer-reviewed/preprint, `[INDUSTRY]` vendor docs/reporting. † = secondary-sourced or unverified (§10).

## 1. A2A mechanics and scope

v1.0 froze 2026-03-12; the project moved into the Agentic AI Foundation 2026-08-17 alongside MCP. `specification/a2a.proto` is normative; JSON Schema is generated `[INDUSTRY: AAIF](https://aaif.io/blog/a2a-v1-0-a-builder-s-guide-part-1-discovery-tasks-and-clients)` `[SPEC: §1.4](https://a2a-protocol.org/latest/specification/)`.

**Agent Card** (`/.well-known/agent-card.json`): `name`/`description`/`version`; ordered `supportedInterfaces[]` (`protocolBinding` × `url` × `protocolVersion` × opaque `tenant`); `capabilities` (`streaming`, `pushNotifications`, `extendedAgentCard`, `extensions`); `skills[]` (id, tags, examples); `securitySchemes`/`securityRequirements`; `defaultInput/OutputModes`. Richer detail only post-auth via `GetExtendedAgentCard`. Signing (§8.4) is JWS over a JCS-canonicalized card in `AgentCardSignature` `[SPEC: quick ref](https://a2a-protocol.org/llms-reference.txt)`.

**Task**: `id`, `contextId`, `status{state,message,timestamp}`, `artifacts[]`, `history[]`, `metadata`. States `SUBMITTED`, `WORKING`, `INPUT_REQUIRED`, `AUTH_REQUIRED`, `COMPLETED`, `FAILED`, `CANCELED`, `REJECTED` — four terminal, two interrupted `[SPEC: quick ref](https://a2a-protocol.org/llms-reference.txt)`. Illegal transitions are named errors: messaging a terminal task is `UnsupportedOperationError`, cancelling one `TaskNotCancelableError` `[INDUSTRY: AAIF](https://aaif.io/blog/a2a-v1-0-a-builder-s-guide-part-1-discovery-tasks-and-clients)`.

**Operations**: `SendMessage` (blocking unless `returnImmediately`), `SendStreamingMessage`, `GetTask`, `ListTasks`, `CancelTask`, `SubscribeToTask`, four push-config methods, `GetExtendedAgentCard`; bindings JSON-RPC/SSE, gRPC, HTTP+JSON; `A2A-Version` required (absent = 0.3) `[SPEC: §3.1](https://a2a-protocol.org/latest/specification/)`. SSE gated on `capabilities.streaming`; webhooks on `pushNotifications`, payload is the `StreamResponse` union (`task`|`message`|`statusUpdate`|`artifactUpdate`), servers must authenticate outbound and must not POST to private ranges (SSRF); receivers must assume duplicates `[SPEC: streaming](https://a2a-protocol.org/latest/topics/streaming-and-async/)`.

**Budgets/attention/authority: absent.** No cost, budget, spend, deadline, or authority field on card or task; `metadata` is the only extension point. AuthN is delegated to web standards ("payloads do not carry identity"); "authorization logic is specific to the agent's implementation," with least privilege and per-skill scopes as obligations on the implementer `[SPEC: enterprise](https://a2a-protocol.org/latest/topics/enterprise-ready/)`. §7.6 "In-Task Authorization" covers only mid-task secondary credentials (hence `AUTH_REQUIRED`) `[SPEC: §7.6](https://a2a-protocol.org/latest/specification/)`. Out of scope: internals/memory/tools/plans (opaque execution), identity provisioning, authorization policy, cost accounting. The gap is acknowledged, not solved: open proposals for per-skill capability tokens `[INDUSTRY: #1716](https://github.com/a2aproject/A2A/issues/1716)` and card identity verification `[INDUSTRY: #1672](https://github.com/a2aproject/A2A/issues/1672)`.

## 2. A2A vs MCP composition

MCP is vertical (agent→tool/resource), A2A horizontal (agent→opaque peer) `[SPEC: A2A and MCP](https://a2a-protocol.org/latest/topics/a2a-and-mcp/)`; Appendix B: MCP = how an agent uses a tool, A2A = how one agent delegates work `[SPEC: App. B](https://a2a-protocol.org/latest/specification/)`. **Delegation sits only in A2A.** MCP has no act-for primitive; a tool call is capability invocation, not transfer of responsibility.

Composition is explicit: one server often does both, the A2A agent calls MCP servers internally, and A2A skills may be exposed as MCP resources when stateless while stateful collaboration stays A2A `[SPEC](https://a2a-protocol.org/latest/topics/a2a-and-mcp/)`. MCP `tasks` (2025-11-25, **experimental**) is the nearest overlap: receiver-generated IDs, `working`/`input_required`/`completed`/`failed`/`cancelled`, `ttl`, `pollInterval`, `tasks/{get,result,list,cancel}` — no budget or authority object, and concurrency is only "receivers SHOULD enforce limits on concurrent tasks per requestor" `[SPEC: MCP tasks](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks)`. MCP authorization uses RFC 8707 resource parameters, CIMD, step-up authorization, and audience binding `[SPEC: MCP authz](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)` — the token authorizes *that* server, never downstream fan-out.

## 3. Adjacent protocols

| Protocol | Standardizes | Omits |
|---|---|---|
| **ACP** (IBM) | agent messaging/runtime REST API | merged into A2A Aug 2025 — don't build on it `[INDUSTRY](https://aaif.io/blog/a2a-v1-0-a-builder-s-guide-part-1-discovery-tasks-and-clients)` |
| **AG-UI** | agent↔frontend event stream + shared state `[SPEC](https://docs.ag-ui.com/spec/1.0)` | identity, authority, budgets, delegation |
| **AP2** | payment authority as signed mandates (intent→cart→payment), verifiable credentials, an A2A layer † | non-payment authority; general delegation |
| **OpenAI Agents SDK** | in-process `handoff(agent, on_handoff, input_filter)` + input/output guardrails `[INDUSTRY](https://openai.github.io/openai-agents-python/handoffs/)` | granter identity, attenuation, budget, compensation |
| **LangGraph** | `Command(goto=..., graph=Command.PARENT)` over a shared state graph `[INDUSTRY](https://langchain-ai.github.io/langgraph/concepts/multi_agent/)` | any authority or cost semantics |
| **MS Agent Framework** | workflows + channels incl. A2A and MCP `[INDUSTRY](https://4sysops.com/archives/microsoft-agent-framework-adds-modular-channels-for-telegram-a2a-and-mcp/)` | delegation warrant, evidence tiers |

All transfer *control*; none transfers *bounded authority*. That asymmetry is AMP's reason to exist — and the reason not to adopt any of them as its delegation substrate.

## 4. Delegated authorization

For "A may act for U with scope S until T": **RFC 8693** `subject_token`+`actor_token` yields `act` (actor) and `may_act` claims; nested `act` gives a chain that is AMP's warrant lineage verbatim `[SPEC](https://www.rfc-editor.org/rfc/rfc8693)`. **RFC 8707** audience-binds each hop so a token for X cannot replay at Y `[SPEC](https://www.rfc-editor.org/rfc/rfc8707)`. **DPoP (RFC 9449)** sender-constrains via `cnf.jkt`, killing bearer replay `[SPEC](https://www.rfc-editor.org/rfc/rfc9449)`. **RAR (RFC 9396)** supplies typed `authorization_details` — the right carrier for amount/payee/tool/max_calls instead of string scopes `[SPEC](https://www.rfc-editor.org/rfc/rfc9396)`. **CIMD** makes client identity an HTTPS metadata document rather than dynamic registration `[SPEC](https://datatracker.ietf.org/doc/draft-ietf-oauth-client-id-metadata-document/)`. **Transaction tokens** — short-lived, per-transaction, workload-bound — are the closest standard analogue of a per-task AMP warrant `[SPEC](https://datatracker.ietf.org/doc/draft-araut-oauth-transactiontokens-bcp/)`. Chains must be carried whole: naive re-exchange enables "delegation chain splicing" `[SPEC](https://datatracker.ietf.org/doc/html/draft-liu-oauth-chain-delegation)`; cf. the AIP draft `[SPEC](https://datatracker.ietf.org/doc/draft-prakash-aip/)`.

**Never delegate**: credential material (no token passthrough — a callee must never receive the caller's downstream token); user consent (only its scope-bounded exercise); scope exceeding the granter's own; re-delegation rights unless `may_act` grants them; authentication (only authorization); irreversible high-impact acts (payment release, deletion, external comms) without a fresh human act or pre-committed mandate.

## 5. Agent identity

Three layers AMP must bind together: **workload** — SPIFFE SVIDs (X.509/JWT), short-lived, attested; strong in-domain, absent cross-org `[SPEC](https://spiffe.io/docs/latest/spiffe-about/spiffe-concepts/)`; **organizational** — `did:web` resolves a rotatable key document from a domain you control `[SPEC](https://w3c-ccg.github.io/did-method-web/)`; **manifest** — A2A `AgentCardSignature` proves the card is untampered, but **a signed card proves claims, not authority, not liveness** `[SPEC: §8.4](https://a2a-protocol.org/latest/specification/)`. "Same agent" across calls = key continuity (`jkt`/SVID), issuer continuity, and card-key continuity across fetches. Cross-domain requires pinning the *issuer key*, not the display name — exactly what AMP Federation attestations should carry. A2A card signing is optional and self-asserted; verifying who signed remains an open proposal `[INDUSTRY: #1672](https://github.com/a2aproject/A2A/issues/1672)`.

## 6. Classical protocols: what survives

**Survives.** Contract Net's announce→bid→award→refuse `[PAPER: Smith 1980](https://doi.org/10.1109/TC.1980.1675516)` as routing vocabulary and FIPA's CNP state machine as naming `[SPEC: FIPA CNP](http://www.fipa.org/specs/fipa00025/DC00025F.pdf)` — but not bidding economics, since LLM bids are uncalibrated: use admission control plus fixed budgets. Blackboard survives as the shared artifact/context store (A2A `artifacts` + `contextId`), not as opportunistic control. Publish/subscribe survives as the attention/interruption bus — the one classical pattern AMP's attention layer should lean on.

**Failed, and why.** FIPA ACL semantics are mentalistic (belief, intention, sincerity, rationality) and unverifiable in open systems, so interop died at the semantic layer while syntax survived `[SPEC: FIPA ACL](http://www.fipa.org/specs/fipa00061/SC00061G.html)`. Tuple spaces and blackboard control assume one administrative domain: no failure model, no authorization, no durability. Lesson: keep the message patterns, drop mental-state semantics, never assume shared trust.

## 7. Distributed-systems patterns that matter

**Necessary.** Idempotency keys on every delegation and side effect, because at-least-once is the default — A2A tells webhook receivers to expect duplicates `[SPEC](https://a2a-protocol.org/latest/topics/streaming-and-async/)`, `[INDUSTRY: Stripe](https://docs.stripe.com/api/idempotent_requests)`. Leases + fencing tokens for task ownership so cancel-then-retry never yields two writers; the resource, not the client, validates the monotonic token `[PAPER: Kleppmann](https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html)`. Sagas with compensations instead of 2PC, which blocks and needs a live coordinator — untenable across minute-long tasks; sagas lack isolation, so add semantic locks and a pivot point `[PAPER: Sagas](https://dl.acm.org/doi/10.1145/38713.38742)` `[INDUSTRY: Azure](https://learn.microsoft.com/en-us/azure/architecture/reference-architectures/saga/saga)`. Cancellation is a *request*: A2A `CancelTask` may fail, MCP `tasks/cancel` is "best effort" but must stick once applied — so **budget and deadline must be enforced locally** `[SPEC: MCP tasks](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks)`. DLQ + lease reaper for poison tasks and expired TTLs `[INDUSTRY: Azure](https://learn.microsoft.com/en-us/azure/service-bus-messaging/service-bus-dead-letter-queues)`.

**Overrated.** End-to-end exactly-once (use idempotency + dedup), global clocks (local deadlines + skew budget), 2PC outside one trust domain.

## 8. Budget/authority controls, with incidents

- Mandiant (Sept 2026): an accounting agent made **>15,000 high-cost API calls in under an hour**, ~**$50,000** in cloud charges; no attacker, no injection — just no rate limit, cost ceiling, or circuit breaker `[INDUSTRY](https://bruno.digital/news/a-runaway-ai-agent-racked-up-50000-dollars-in-cloud-charges-in-under-an-hour-no-attacker-required)` †.
- **63 confirmed budget-overrun incidents across 21 frameworks (2023–2026)**, **11 involving a delegation-fanout race**; naive `asyncio` overshoots **30/30** in their harness, an affine-typed budget **0/30** `[PAPER: arXiv 2606.04056](https://arxiv.org/abs/2606.04056)` — preprint.
- Multi-agent topologies reported at ~**15×** chat token usage `[INDUSTRY: Anthropic](https://www.anthropic.com/engineering/multi-agent-research-system)` †.

Consequence: **metering is not control.** A counter checked after the call is bypassable under delegation races; you need reservation before dispatch, hierarchical attenuation (child ≤ parent remaining), concurrency caps per principal, and a hard stop at the payment rail. Escalation mints a *new* grant from higher authority — it never widens an existing one.

## 9. Minimal delegation object + invariants

```json
{ "id": "...", "parent": "...|null", "chain": ["..."],
  "granter": {"sub": "did:web:a.example", "key": "jkt-..."},
  "delegatee": {"sub": "spiffe://b.example/agent/x", "key": "jkt-..."},
  "task": {"goal_digest": "sha256:...", "inputs_digest": "sha256:..."},
  "scope": [{"type": "tool.invoke", "id": "crm.read", "constraints": {}}],
  "budget": {"tokens": 200000, "usd_micros": 5000000, "calls": 200,
             "concurrency": 4, "reserved": 0},
  "deadline": "2026-10-24T18:00:00Z",
  "compensation": {"action": "undo.write", "authority": "..."},
  "evidence": {"tier": "attested", "required": ["artifact.sha256", "receipt"]},
  "cancel": {"token": "...", "propagate": true},
  "may_redelegate": false, "depth": 3, "nonce": "...", "exp": "...", "sig": "..." }
```

**Mapping.** A2A: carry it in `Message.metadata` (or an extension) on `SendMessage`; `taskId`/`contextId` correlate; `AUTH_REQUIRED` is the escalation channel; `artifacts` carry evidence; terminal-state errors give immutability free. MCP: callee tool calls carry a transaction-token-style header plus per-effect idempotency key; MCP task `ttl` caps the lease.

**Invariants enforced locally, never delegated to the peer:** (1) monotonic attenuation; (2) single writer per task via fencing; (3) reserve-then-settle, reserved ≥ in-flight worst case; (4) child deadline ≤ parent deadline; (5) cancellation sticky, no resurrection from `CANCELED`; (6) every external effect has an idempotency key; (7) evidence signed by the delegatee key named in the grant; (8) no token passthrough, each hop audience-bound; (9) re-delegation only with `may_redelegate`, decrementing depth; (10) terminal states immutable.

## 10. Confidence and gaps

**High:** A2A v1.0 mechanics/states/fields/streaming; MCP tasks and authorization; RFCs 8693/8707/9396/9449. **Medium:** MCP task details (experimental); LangGraph/MAF specifics; Anthropic's ~15×. **Low (†):** AP2's mandate taxonomy — `ap2-protocol.org` and the CSA explainer both returned 403, so AP2 rests on secondary sources; the Mandiant incident is press-reported (primary report unread); the 63-incident catalog is a single-author preprint. Linda tuple spaces and blackboard control are textbook claims, not linked. **Open gaps:** no standard defines budget semantics or a cross-vendor delegation object; A2A card-signature adoption unknown; no audited public dataset of fan-out incidents — only preprint and press.
