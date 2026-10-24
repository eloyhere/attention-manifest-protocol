# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Context economy. `planPrune()` builds an explicit view of a verified ledger: superseded
  claims, closed hypotheses and resolved non-blocking unknowns leave it, every omission
  carries a `reason` and a `revisit_if`, and citations are closed over so that nothing
  dangles. `supersedes` is deliberately not treated as a dependency.
- `compactLedger()` replaces a cold prefix with a checkpoint that commits to the digest of
  the removed entries. `verifyCompaction()` re-derives that commitment and checks that the
  tail continues the same chain. Compaction refuses to bury an entry the retained tail still
  cites, and raises `CompactionRefused` with the pinned references.
- `compaction.schema.json` covering checkpoints and prune plans, two worked examples
  (`checkpoint.json`, `prune-plan.json`), and `docs/compaction.md` with invariants P-1 to P-7.
- `tools/compaction-check.ts` with 15 assertions, wired into `npm run verify`.

### Changed

- Counts moved with the new layer: schemas 14 → 15, validated example objects 33 → 35,
  verification entries 29 → 30, TypeScript scripts under `tools/` 38 → 39.
- All 38 scripts under `tools/` migrated from JavaScript to TypeScript. They run directly
  under Node's type stripping and are covered by `tsconfig.tools.json`; no `.mjs` file
  remains.
- `npm run verify` now runs both type checks — `tsc --noEmit` for `src/` and
  `tsc -p tsconfig.tools.json` for `tools/` — so a type error in the tests fails the suite.
- Test fixtures declare the protocol types they build (`Claim`, `EvidenceItem`,
  `Hypothesis`, `Candidate`, `MergeClaim`, `TeamManifest`, `AttentionRequest` and an
  unsigned `Manifest`) instead of widening string literals.
- HTTP suites use the shared `listen()` and `portOf()` helpers rather than untyped calls
  to `server.address()`.
- Documentation, the script paths in `package.json` and the README were updated for the
  rename.

### Fixed

- `a2a-check` compared the digest of a runtime `Delegation` with the digest of the same
  object passed where a `DelegationDoc` was expected, so both sides hashed the camelCase
  object and the assertion could never fail. It now converts with `toDelegationDoc()` and
  compares the digest of the document with the digest of the document.
- `persistence-check` spread a hash-chain payload typed `unknown`; the payload is now
  narrowed explicitly at the test boundary.
- `sign-check` imported a type in the middle of a multi-line import statement after the
  automated rewrite; the import order is now correct.

## [0.1.0] - 2026-10-24

First public reference implementation.

### Added

#### Protocol and types

- 14 JSON Schemas under `docs/schemas/`, with TypeScript types in one-to-one
  correspondence.
- A message envelope and seven speech acts: `attend`, `plan`, `act`, `ask`, `note`,
  `reflect` and `read`.
- Twelve invariants: W-1 to W-5 (warrant), A-1 to A-5 (attention), M-1 (manifest) and
  X-1 (log).

#### Attention

- A salience contract with a monotonicity rule, plus focus and ignore sets.
- An immutable frame chain; `Frame.ignored` records exclusions with `reason` and
  `revisit_if`.
- Impasse classification, and interrupt classes with attention debt.
- Hard budget enforcement at the dispatcher: allocation may degrade to handles,
  pagination or refusal, but never truncates silently.
- Handle-based overflow, so that large results stay addressable.

#### Warrant

- T0–T4 epistemic tiers, confidence derivation and tier validation.
- Minimal revision with a `supersedes` chain.
- Explicit unknowns and stopping rules, with preregistration and reproduction checks.

#### Execution

- An MCP 2026-07-28 client: stateless `_meta`, `server/discover`, `ttlMs` and `cacheScope`,
  HTTP binding headers, and a fallback to the legacy `initialize` handshake.
- A budget dispatcher as the single metering point, with approval gating and TTL caching.

#### Federation and trust

- `ManifestBundle` and `Attestation`, digest pinning, revocation, and import that fails
  closed.
- Agent Card discovery and JWS/EdDSA card signatures.
- Bundle keys, endorsement and scope policy; an A2A `message/send` binding that surfaces
  JSON-RPC errors.

#### Collaboration

- Delegation with tier decay, ten invariants, lease fencing and depth limits.
- A task board, result merging with contested-value handling, and authority adjudication.
- A unified ledger, metrics (duplicate-task rate, alignment-token share, cost per success
  and contested rate) and an end-to-end session.

#### Persistence and sharing

- An append-only hash chain over events, frames, receipts, claims, hypotheses, unknowns,
  goals and plans.
- Snapshot verification by count, tip, hash and chain order; restore refuses a broken
  snapshot.
- Three sharing granularities.

#### Documentation and tooling

- `docs/architecture.md`: the normative specification.
- `docs/rationale.md`: twelve ADRs, each with its evidence, its cost and the options that
  were rejected.
- Multi-agent, trust-chain and federation documents, and nine research briefs.
- 29 verification entries (166 counted assertions), 4 example generators and 5 endpoint
  probes, plus 33 example objects validated against the schemas.

### Security

- Budgets are enforced at one point, in response to the class of failure represented by
  CVE-2026-114386, where nested tool calls bypassed a per-run quota.
- External content cannot raise its own salience; promotion requires a trusted signal.
- Delegation, federation import and channel operations fail closed, each recording a
  reason.

### Known limitations

- Sandbox isolation, multi-tenancy and interactive OAuth authorisation are not implemented.
- Cross-domain tests run locally; interoperability with external agents has not been
  demonstrated.
- The specification and the research briefs are written in Simplified Chinese.
