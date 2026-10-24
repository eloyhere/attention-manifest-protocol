# Attention Manifest Protocol (AMP)

**English** · [简体中文](README.zh-CN.md)

> Let an agent come to know the universe scientifically — and spend its attention where it is needed.

AMP is a **metacognitive protocol**. It does not prescribe how a model thinks. It prescribes how an agent *declares* what it knows, what it wants and what it is attending to, and how it decides where to look next when attention is finite.

It keeps two ledgers, and they answer two different questions.

| Ledger | Records | Answers |
| --- | --- | --- |
| **Warrant Ledger** | claims, evidence, hypotheses, unknowns, concepts, plans | Why should I believe this? |
| **Attention Ledger** | attention frames, budgets, receipts, interrupts | Where did my cognition go? |

A controller trades between them: a finite amount of attention, spent to buy the warrant that is worth most.

## Three objects

| Object | Lifetime | Answers |
| --- | --- | --- |
| `Manifest` | durable, TTL-bounded, signable | Who am I? What can I do? What have I undertaken to do? What am I missing? |
| `Frame` | one attention cycle, immutable | What am I looking at? Why this? **What am I ignoring?** |
| `Receipt` | every action | How much attention did it cost? What did it return? |

`Frame.ignored` is the field with no direct precedent. Classical cognitive architectures record what was attended to; they do not record what was deliberately excluded, on what grounds, and when it should be reconsidered.

## What is implemented

| Layer | Capability |
| --- | --- |
| Protocol | 15 JSON Schemas, TypeScript types in one-to-one correspondence, a message envelope and seven speech acts |
| Attention | salience contract, focus and ignore sets, impasse classification, interrupt classes and debt |
| Warrant | T0–T4 epistemic tiers, confidence derivation, minimal revision, unknowns and stopping rules |
| Execution | MCP 2026-07-28 client (stateless and legacy fallback), budget dispatch, handle-based shaping |
| Federation | `ManifestBundle` and `Attestation`, digest pinning, revocation, import that fails closed |
| Collaboration | delegation decay, lease fencing, task board, result merge and conflict adjudication, unified ledger |
| Trust | Agent Card discovery and signing, bundle keys, scope policy, A2A `message/send` |
| Persistence | append-only hash chain, snapshot verification, restore that refuses corrupted data |
| Context economy | prune plans over a verified view, checkpoints over a cold prefix, both refusing to bury a live citation |

## Repository layout

| Path | Contents |
| --- | --- |
| [`docs/architecture.md`](docs/architecture.md) | Normative architecture: model, attention, warrant, planning, protocol, security, consistency, adoption |
| [`docs/rationale.md`](docs/rationale.md) | Twelve ADRs, each with its evidence, its cost and the options that were rejected |
| [`docs/multi-agent.md`](docs/multi-agent.md) | Multi-agent work: admission rules, delegation objects and their ten invariants, team objects, eight failure signals |
| [`docs/trust-chain.md`](docs/trust-chain.md) | Trust chain: discovery → card signature → bundle keys → endorsement → scope policy |
| [`docs/federation.md`](docs/federation.md) | Cross-domain bundles and third-party attestation |
| [`docs/compaction.md`](docs/compaction.md) | Context economy: pruning as an explicit view, compaction as a committed checkpoint |
| [`docs/research/`](docs/research/) | Nine research briefs, including a real-endpoint compatibility matrix and citation conventions |
| [`docs/schemas/`](docs/schemas/) | 15 JSON Schemas |
| [`docs/examples/`](docs/examples/) | 35 validatable examples: frame chains, claims, plans, delegations, bundles, snapshots, checkpoints |
| [`src/types/`](src/types/) | TypeScript types, one for one with the schemas |
| [`src/runtime/`](src/runtime/) | Reference runtime (see the table below) |
| [`tools/`](tools/) | 30 verification scripts, 4 example generators and 5 real-endpoint probes — all TypeScript |

Runtime modules:

| Module | Responsibility |
| --- | --- |
| `runtime.ts` / `ledger.ts` | The seven verbs, the frame chain, receipts, the Manifest, self-audit |
| `attention.ts` / `budget.ts` / `handles.ts` | Salience, the single metering point, handle-based pagination |
| `warrant.ts` / `inquiry.ts` | Confidence derivation, tier validation, preregistration and reproduction |
| `exec.ts` / `mcp/` | MCP execution, digest pinning, approval, TTL caching |
| `federation.ts` / `sign.ts` / `card-sign.ts` / `trust.ts` | Signatures, bundles, attestation, card verification, scope policy |
| `team.ts` / `board.ts` / `merge.ts` / `metrics.ts` / `session.ts` | Delegation, task board, merge, metrics, end-to-end session |
| `channel.ts` / `http-channel.ts` / `a2a.ts` | Transport seams, idempotent HTTP channel, A2A binding |
| `persistence.ts` / `share.ts` / `compaction.ts` | Hash-chain snapshots, sharing granularities, pruning and compaction |

## Quick start

```bash
npm run verify            # 30 verification entries plus two type checks (src and tools)
npm run scenario          # end-to-end incident: delegation → MCP → merge → attention → metrics
npm run demo              # emit a runtime trace
npm run typecheck         # strict type check for src/
npm run typecheck:tools   # type check for tools/, so the tests are checked too
```

There is no JavaScript under `tools/`. All 39 scripts are `.ts`, run directly by Node's
type stripping, and included in `tsconfig.tools.json`, so the test code is held to the
same type contract as the runtime.

Real endpoints (network access required):

```bash
npm run live-test     # context7 (2026-07-28)
npm run live-legacy   # mslearn + deepwiki (legacy handshake fallback)
npm run oauth-probe   # OAuth discovery chain for Linear and Figma
```

## Where to start reading

1. [`docs/architecture.md`](docs/architecture.md) §1 — why AMP is needed, with a summary of the evidence
2. §3 — the two ledgers, the three object types and the 12 invariants
3. §6 — the warrant layer: T0–T4, falsifiability, epistemic hygiene
4. §12 — the consistency vectors V1–V15
5. [`docs/compaction.md`](docs/compaction.md) — pruning and compaction, the two ways a ledger stays affordable
6. [`docs/examples/frame-chain.json`](docs/examples/frame-chain.json) — a real frame chain

## Status and boundaries

`v0.1.0`. Fifteen schemas, 35 example objects, 30 verification entries and 181 counted
assertions, all passing. The normative specification and the research briefs under
`docs/` are currently written in Simplified Chinese.

**What it does not claim.** It does not claim understanding. It claims only that beliefs
are declarable, chargeable, refutable and auditable. It takes no position on consciousness.

**What is not implemented.** Sandbox isolation, multi-tenancy, interactive OAuth
authorisation and interoperability with real external agents; every cross-domain test runs
locally. The reference implementation deliberately omits the environment-layer capabilities
that a production deployment would need.

## Documentation and change history

- [Architecture specification](docs/architecture.md)
- [Rationale and ADRs](docs/rationale.md)
- [Changelog](CHANGELOG.md) · [更新日志（中文）](CHANGELOG.zh-CN.md)

## Licence

The package is marked `UNLICENSED`: no licence is granted for reuse until one is added.
