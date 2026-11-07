# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.7.4] - 2026-11-07

### Added

- Dedicated `.log` language and outline parser (`src/file/language/log.ts`). Entries are grouped by calendar day, then severity (`FATAL`/`ERROR`/`WARN`/`INFO`/`DEBUG`/`TRACE`), then individual line. It recognises ISO timestamps (`2026-11-07T12:34:56.789Z`), `YYYY-MM-DD HH:MM:SS,mmm`, syslog (`Nov  7 12:34:56`) and bare level lines (`ERROR ...`, `[warn] ...`); continuation lines such as stack traces attach to the preceding entry.

### Changed

- `.log` is no longer handled by the plain-text scanner; it resolves to the new `log` language through `createDefaultLanguageRegistry()`.

## [0.7.3] - 2026-11-07

### Changed

- Upgraded `semantic-typescript` from `^2.0.0` (locked 2.0.0) to `2.0.1`, which fixes an upstream fatal bug. Serialization smoke checks confirm circular and shared references are still filtered, `digestOf` stays key-order independent, and `traverseSafely` skips cycles.

## [0.7.2] - 2026-11-07

### Added

- Evidence arbitration, fusion and cross-agent acceptance (§5.5/§5.7/§5.8): `arbitrate`, `fuseEvidence`, `crossAgentAcceptance`.
- Capability and behavior lifecycles (§6.4–6.8, §7.4–7.6): tool/skill/protocol/cognition state machines, propagation, `abstractBehavior`/`evaluateBehavior`/`publishBehavior`.
- Receipt rollback, aggregation and cross-agent verification (§9.4–9.6): `planRollback`/`applyRollback`, `aggregateReceipts`, `verifyForeignReceipt`.
- L3 attention scheduling (§11.9): nine-stage routing, focus/blur/switch/suppress, mind-map routing, decision log and top-N scheduled context.
- L5/L7/L8 (§11.11/§11.13/§11.14): `selectCognition`/`evaluateCognition`, `FusionLayer`, `SedimentPipeline`.
- `learn` and `feedback` lifecycles; workflow propagation (§4.9) with cancellation cascade; five-topology executors with consensus voting and merge receipts.
- Kernel flow for project/workspace/file, file operation receipts chained into evidence, and budget-exhaustion propagation to turn/session.
- JPA cascades (`cascade: "persist" | "remove" | "all"`), session/turn receipts, structured file diff, project agent tools, view anchor registry, six-dimensional budget, outline `versionHash` enforcement and circular-safe serialization with `filterShared`.

### Changed

- `hashAlgorithm` for execution facts is now `sha256-json-execution-facts/2`.

## [0.7.1] - 2026-11-07

### Removed

- Test files are no longer part of the repository; the published package contains `lib/` only.

## [0.7.0] - 2026-11-07

### Added

- **32 built-in languages**, including Go, Swift, XML, JSON (JSONC-tolerant) and compressed archives; TeX gains `part`/`subparagraph` levels. All are registered in `builtinLanguages` and discoverable through `createDefaultLanguageRegistry()`.
- Legacy Office readers: `.doc` (FIB plus Clx/PlcPcd piece table), `.xls` (BIFF8 `BOUNDSHEET`, `SST` with `CONTINUE`, `RK`, `MULRK`, cached formula values) and `.ppt` (MS-PPT record tree). `parseWord`/`parseExcel`/`parsePowerPoint` dispatch by container magic, so OLE and OOXML families share one language definition.
- PhotoShop Large Document support: PSD v1 and PSB v2 share a full layer tree with groups (`lsct`/`lsdk`), `luni` names, bounds, blend and opacity, and honour the 64-bit length fields of PSB.
- Dependency-free CFB/OLE reader (FAT, miniFAT, DIFAT, directory tree, property sets). `.max` and SolidWorks parts/assemblies/drawings now return a complete container outline instead of an unsupported error; the proprietary scene graph and feature tree remain explicitly undecoded.
- DWG version detection and, for R13/R14/R2000, section-table metadata. R2004+ sections are compressed and encrypted and still fail with a precise `unsupported_format`.
- Archive outline reader for ZIP (central directory only, no extraction), TAR (ustar, GNU long name, pax), TAR.GZ and GZ. 7z, RAR, XZ, bzip2 and zstd fail with a reason instead of an empty listing.
- `Project.environment`: a versioned, CAS-guarded environment (variables, paths, dependencies) with `configureEnvironment`, `setEnvironment`, `environmentPlan` and `describeEnvironment`; `createProjectFromKind`/`applyProjectKind` seed it from a project kind while preserving project overrides.
- Tiered agent surface (`agent`/`host`/`hidden`) under `attention_manifest_protocol_<module>.<verb>`, plus `AgentGateway` with host-bound identity, parameter-smuggling rejection, idempotency keys for mutating verbs, an authorization hook and one journal record per call.
- `attention_manifest_protocol_discover`: a bootstrap discovery entry over host-registered modules, AMP tools, current-session files/content and outlines, conversation and opt-in network. It returns a bounded `query → source → group → item` relevance tree with lexical, semantic, signature and context scores, and accepts generic `DiscoveryProvider` ports instead of binding to a plugin runtime.
- Elasticsearch discovery adapter (`createElasticsearchDiscoveryProvider`) over the existing `@elastic/elasticsearch` dependency: one index per source, tenant/session term filters, `_source` document validation and optional normalized BM25 `scoreSignal`.
- End-to-end scenario suite (`npm run scenario`) covering bug-fix loops, stale detection, lease fencing, BOM/CRLF fidelity, code-point byte boundaries, binary documents, corrupted formats, archive budgets, path traversal, size ceilings, project environments and gateway authorization.
- **Persistence stack.** Five layers now carry an aggregate from metadata to disk: `entity` (JPA-style `Entity`, `Key`, `Column`, `Index`, `UniqueConstraint` and `Association` metadata, plus `ManyToMany<Target>` and the other association wrappers; no `Metadata` suffix), `cache` (an independent TTL LRU over `semantic-typescript`'s `SynchronousOrderedLRUMap`, with `createEntityCache`, `createServiceProxy`/`ServiceRegistry` and `createCachingProxy`; service proxies cache reads and invalidate a namespace on writes), `service` (`Store`: global identity map, lazy loading proxies, write-through mutations with CAS, `new`/`managed`/`detached`/`removed` states and nested transactions), `repository` (generic `Repository<T>` with `expectedVersion` CAS and an append-only event log) and `sql`/`connection` (`node:sqlite` with WAL, foreign keys and versioned migrations; a synchronous connection pool with transactions and LIFO savepoints). Cascades are declared in the metadata but not executed in this release.
- Hidden persistence directory: `Store.open()` defaults to the git-ignored `.attention-manifest-protocol/store.sqlite`; `path` accepts a directory, an explicit `.sqlite` file or `:memory:`.

### Changed

- Binary files mount as opaque bytes: `readBytes`, `writeBytes` and `flush` through `compareAndSwapBytes`, while text APIs fail with `invalid_target`.
- `package.json` no longer advertises the removed `docs/schemas` export or the deleted scoped-control guide.
- `attention-manifest-protocol/agent` now resolves to both the surface registry and the gateway.

### Validation

- 460/460 baseline tests (including 14 end-to-end scenarios), strict typecheck, `build`, `build:lib` and `demo:architecture` passed before the current additions.
- Persistence: 81/81 focused tests pass across `entity`, `cache`, `connection`, `repository`, `sql` and `service`; a final full-suite re-run is pending.

## [0.6.1] - 2026-11-03

### Added

- `ProtocolRegistry` can bind a runtime implementation to a registered protocol entry: `bind`, `implementation`, `resolveImplementation` (type-guarded, optional family check) and `bound`. Implementations are stored by reference and never appear in discovery metadata, and `remove`/`clear` drop the bound implementation together with the entry.
- `ProtocolEntry.family` names the protocol family, so entries registered by `ProtocolRegistry` can be filtered by protocol (`mcp`, `a2a`, ...).
- MCP is registered as a concrete protocol rather than a separate registry: `mcpProtocolEntry` builds a `family: "mcp"` entry with its protocol version, endpoint and capabilities, and `mcpListTools`, `mcpSyncTools` and `mcpWithdrawTools` read and mirror an endpoint's tools through the bound implementation.

### Validation

- Joint regression: 189/189 and 50/50 across protocol, registry, discovery, MCP executor, workspace and database suites; source and tools typechecks passed.

## [0.6.0] - 2026-11-03

### Added

- `outlineAddress(range, charset, bounds)` and the related line/byte request helpers convert an outline node's `range` into the `startLine`/`endLine` and `offsetBytes`/`endBytes` fields the workspace read and write tools accept, removing the UTF-8 BOM prefix and failing closed on reversed, out-of-bounds or non-representable values.
- Every mutable registry is read-write: `SkillRegistry`, `KnowledgeRegistry`, `ProtocolRegistry`, `ToolRegistry`, `OutlineRegistry`, `OutlineKeywordRegistry`, `SyntaxRegistry`, `SqlDialectRegistry`, `CalibrationRegistry`, `BehaviorRegistry` and `EntityRegistry` expose `update` and `remove` (plus `clear` for list-shaped containers) on top of `register`.

### Changed

- Writing a file now rebuilds that file's outline and drops its previous cache generation in the same call, so a later outline read never serves the pre-write tree and storage keeps one cache row per file instead of one per edit.
- `SyntaxRegistry.updateLanguage` and `removeLanguage` release the language's extensions so a new language can claim them.

### Fixed

- The session-scoped filesystem store did not forward `removeOutline`, silently dropping cache invalidation; it now scopes and forwards it.
- The calibration registry now accepts a host-supplied model for a scope it has never fitted, so persisted calibration can be restored.

### Validation

- Joint regression: 168/168 across registry, discovery, outline, runtime and database suites; source and tools typechecks passed.

## [0.5.0] - 2026-11-03

### Added

- Eight canonical scoped control tools for registry metadata, defaults, interaction and scenario settings across global, workspace and session scopes; host-bound identities, CAS, dry-run and atomic session batches.
- SQLite workspace ownership, default workspace selection, inherited settings and v4-to-v5 migration, with authenticated runtime settings applied on the next turn.
- Elasticsearch catalog search with independent immutable snapshot indices, verified namespace ownership, SQLite publication CAS, retryable timeout/restart recovery and guarded Catalog SQL writes.
- Environment defaults, typed catalog projections and serial module boundary audit reports.

### Changed

- **Breaking:** workspace/global discover now requires `queries` and asynchronous calls, returning a separate relation tree for each match. Migrate from the old `text`/`scope` filter arguments; configure and synchronize the host search backend before discovery.

### Fixed

- Isolate session root storage while preserving public root IDs; prevent stale session registries from reviving revoked credentials, authentication reentry and revision overflow.
- Reject hidden JSON callbacks and mutable protocol schemas; enforce workspace ownership even when a stdio host is configured with search only.

### Validation

- Joint functional and boundary regression: 366/366; final audit recheck: 48/48; source/tools typechecks, library build and patch checks passed. Real Elasticsearch 9.2.0 single-node faults were previously verified 9/9; fixture tests are reported separately.
- Known repository limitation: the architecture check still fails on coexisting legacy dashed and camelCase scripts; it is excluded from the functional counts above.

## [0.4.6] - 2026-11-02

### Added

- Host-owned `SkillRegistry`, `KnowledgeRegistry` and `ProtocolRegistry` with validated registration, duplicate rejection, defensive copies and deterministic listing.
- Metadata-only `skills`, `knowledge` and `protocols` discovery scopes, with registry injection through workspace and global agent services. Disabled skills and protocols are excluded from discovery.

### Changed

- Share in-memory registry storage and query mechanics through `InMemoryRegistry` while keeping validation and list policies in each domain.

### Fixed

- Reserve discovery node capacity for ancestors before visiting descendants so tight limits preserve tree structure and accurate summary counts.

## [0.7.0] - 2026-11-07

### Added

- Elasticsearch search module using the official SDK, explicit strict index mapping, scoped metadata search, full snapshot synchronization and defensive response projection.
- Unified catalog entities, directed relations, cache, service, repository and SQLite tables with atomic snapshot replacement, persistent synchronization generations and retryable dirty states.
- Workspace/global discover now accepts one or multiple `queries` and returns a separate bounded relation tree for every matching root; services, executors and MCP support asynchronous search. This replaces the previous discover tool filter schema.
- Typed catalog projections for workspace, host projects/components, skills, knowledge, protocols, environments and generic module records; SDK wire, SQLite, projection and multi-tree isolation checks.
- Explicit environment defaults for runtimes, applications, languages and project types, backed by `HostCatalog`, with category/availability metadata and links.

- `amp_tool_workspace_project`: offline brand detection from manifest/lockfile evidence (npm/pnpm/yarn/bun, Maven, Gradle, CMake, Cargo, Go, Python, Make, Composer, .NET, Bundler, Swift, sbt) plus host-delegated `build`/`compile`/`run`/`test`. The agent never supplies a command string; the brand table produces one and `WorkspaceServiceOptions.runner` decides whether to run it (`run_unavailable`, `unsupported_action`, bounded tail of stdout/stderr).
- `amp_tool_workspace_outline`: one cascading project → directory → file → symbol/knowledge outline with 1-based ranges, bounded `maxDepth`/`limit`, `childCount`, `includeSymbols` and path/extension filters.
- `amp_tool_workspace_dependency`: project-level `project_depends_on` dependencies and dependents with the declaring source, method and paginated project list.
- `amp_tool_workspace_reactive_read` / `amp_tool_workspace_reactive_write`: a Proxy-backed tree whose properties materialize lazily and are cached per service instance. Annotations (`summary`/`label`/`tags`) update a local overlay and bump `cacheVersion`; `content` goes through the guarded `write` path. Global mirrors `amp_tool_global_reactive_*` are registered in the naming table.
- `amp_tool_workspace_diff_read` / `amp_tool_workspace_diff_write`: a comparable tree carrying each file's content revision and byte/line metrics (optionally bounded content, gated by the materialized Context), and a write that accepts a whole file, 1-based line splices or UTF-8 byte splices, reports the line diff and hunks, and reuses the write port, CAS and dry-run. `src/context/workspaceDiff.ts` holds the pure splice/diff helpers and reuses `diffText` from `src/hook/diff.ts`.
- `amp_tool_workspace_write`: replace a project file by whole node, 1-based line range (`startLine`/`endLine`) or UTF-8 byte range (`offsetBytes`/`endBytes`), with `expectRevision` compare-and-swap and `dryRun`. The service reuses the Frame allocation `read` requires and delegates persistence to the host-supplied `WorkspaceWriter`; without one the call fails with `write_unavailable`. The reply carries the same `exportation`/`importation` facts as `read`.
- `amp_tool_workspace_read` pages by 1-based lines (`startLine`/`maxLines`) and UTF-8 bytes (`offsetBytes`/`maxBytes`) in addition to character offsets, and every page carries `exportation` (relative files importing the target's file) and `importation` (relative files it imports, with bare specifiers in `external`), so an edit can be scoped without a second relation query.
- Agent workspace: a `File`/`Directory` tree, paged reads, CAS atomic writes, strategy-based outlines, import/export/dependency graphs and Office parsing (DOCX/XLSX/PPTX, with best-effort DOC/XLS/PPT/PUB/ACCDB).
- Session module: `ses_` identity, one-time bearer token, TTL, suspend/revoke/rotate, fork, per-session context isolation and quotas; SQLite adapters `SqliteWorkspaceSessionStore` / `SqliteWorkspaceSessionContextStore`.
- `src/hook`: `useRead`, `useWrite`, `useDiff`, `useParse`, `useDependency`, `useExportation`, `useImportation`, `useOutline`, `useCode`, `useProject`. Every hook is read-only except `useWrite`, and runs are recorded in `hook_runs`.
- `amp_tool_filesystem_*` (ten tools), the `amp_tool_globalfs_*` global naming adapter, and `amp_service_filesystem` / `amp_protocol_filesystem`.
- Lossless read-only syntax trees: `amp_tool_filesystem_ast`, `useAst`, `src/syntax/syntaxTree.ts` and `src/syntax/syntaxRegistry.ts`; languages, token kinds and node kinds are registry data, every token keeps UTF-8 byte and line ranges, and the target file is never executed.
- SQLite tables: `workspace_sessions`, `session_roots`, `session_context`, `file_nodes`, `file_annotations`, `file_writes`, `file_outlines`, `file_imports`, `file_exports`, `file_dependencies`, `hook_runs`.
- Data structures: `Trie`, `ByteLineIndex` (segment-tree prefix sums) and `OutlineIndex` (AST + Trie + SegmentTree).
- Outline strategies cover code (TS/JS/Python/Java/C/C++/C#/Go/Rust), Vue, project manifests (npm/Maven/Gradle/CMake/Cargo/Go/pyproject/Make), prose (Markdown/TeX/plain text), HTML/CSS/SCSS/Sass/XML/OPML and Office; `outlineCoverageCheck` verifies 74 cases.
- Outline keyword registry: `OutlineKeywordRegistry` registers variable/function/type/import/modifier/control/literal keywords; global variables/constants, global functions, class properties/methods and `static` members become nodes, with a `modifiers` chain (`static`/`public`/...).
- `src/context` adds `ContextPackage`/`ContextBuilder`/`relevance`: budgeted assembly, relation closure, omissions, trie path prefixes and segment-tree line ranges.
- Source file names standardised on lowerCamelCase: 148 hyphenated `tools/` files were renamed with all references fixed, and `archCheck` now rejects new hyphenated names.
- Responsibility and interaction assignment: `responsibility-assignment` (duties, RACI, authority/budget/window attenuation, acceptance, evidence-based discharge and cascade revoke) and `interaction-binding` (parties, protocol roles, mode mix, cadence, escalation and handoff), with schemas, examples, ledgers, optional links from `delegation`/`result-contract`/`receipt`/`message`, and `assignment-check` / `interaction-binding-check`.
- `src/discover`: `HostCatalog` for host-registered projects, plugins, services, tools and modules, plus `buildDiscoveryTree`, which returns one bounded structural tree over the authorized workspace snapshot. Project nodes carry description, purpose and summary; file nodes carry module classification (`service`/`tool`/`controller`/`route`/`repository`/`model`/`config`/`test`/`middleware`/`component`/`util`), extension and at most three bounded content snippets. The new `amp_tool_workspace_discover` tool exposes it to agents; `discover-check` and `discover-agent-check` cover the tree, content matching, host catalog, authorization filtering and tool envelope.
- `src/fingerprint`: one definition of what a digest covers. `fingerprintBytes`, `fingerprintText`, `fingerprintString`, `fingerprintNumber`, `fingerprintJson`, `fingerprintFile`, `fingerprintFileMeta` and `fingerprintTree` each return a reference carrying the algorithm, kind, policy, payload size and digest; `verify`/`matches` compare all four fields instead of a bare hex string; `rawDigest`/`rawHex`/`rawTextDigest` centralise the unframed content-address form. Directory trees use domain-separated Merkle leaves and nodes (RFC 6962 shape) and hash file bytes, so two different binary files can no longer share a module digest. `fingerprint-check` covers 47 cases, including the cross-check against `node:crypto` and the legacy collisions.
- `src/naming`: the frozen id table, the `amp_<kind>_<component>[_<leaf>]` grammar with a parser and a formatter, the v0.5 compatibility aliases, and a catalog with a stable digest (`buildCatalog`/`verifyCatalog`). `naming-check` covers 26 cases.
- `tools/fingerprintCheck.ts` and `tools/namingCheck.ts` joined `npm run verify`; both are also standalone scripts.

### Changed

- Workspace tool descriptors now carry `risk` (`read`/`write`) instead of every tool being described as read-only; the catalog digest, registry descriptors and MCP `readOnlyHint`/`destructiveHint` annotations are derived from it, and `GlobalAgentService` accepts the same optional `writer`.
- Consolidated project guidance into the English and Chinese READMEs; evaluation summaries now remain JSON-only.
- Tool ids are now `amp_tool_workspace_capabilities|tree|query|relations|materialize|read|release|discover`. The `amp_workspace_*` spellings remain accepted as input aliases for one minor version and are reported in `deprecatedAliases`; `tools/list` advertises only the canonical ids.
- The workspace response `protocol` value is `amp_protocol_workspace` and `serverInfo.name` is `amp_service_workspace`; `server/discover` and `initialize` also carry `serviceId` and a catalog summary. `WorkspaceProtocolAliases` exports the old `amp.workspace` value for hosts that still compare it.
- The workspace protocol surface moved from `src/context/workspaceProtocol.ts` to `src/protocol/workspace.ts`; `src/context/index.ts` re-exports it, so the root entry is unchanged.
- `canonical()` now rejects unpaired surrogates and `-0`, matching RFC 8785 §3.2.2.2 and appendix B. Callers that really mean "treat `-0` as `0`" must pass `{ negativeZero: "as-zero" }` to the new `canonicalJson`. Values without those two shapes produce exactly the same bytes as before.
- `src/fingerprint/json.ts` delegates to that single encoder instead of keeping a second copy of the JCS rules.
- `ContentStore` and the workspace integrity check now derive and validate refs through `rawTextDigest`/`parseShort`, and `registry/content.ts` hashes file bytes instead of decoded text. Module digests of UTF-8-only trees are unchanged.

### Fixed

- `diff_write`/`applyLineChanges`/`applyByteChanges` now reject overlapping (and same-offset byte) edit ranges as `invalid_arguments` instead of silently dropping one edit based on array order; adjacent ranges stay legal. The write ceiling is also passed to the helpers during assembly, so a batch that only grows past `maxWriteChars` fails closed before allocating the whole result.
- `reactive_write` annotation replies report `revisionOf(node)` rather than the snapshot revision, so the value can be reused as `expectRevision` after a content write; annotation `dryRun` no longer mutates the overlay or bumps `cacheVersion`.
- `importation` now exposes `externalTotal`/`externalTruncated`, so `maxFileLinks` truncation of bare package specifiers is visible instead of silently dropping entries.
- `read` of a symbol or knowledge page whose containing file was written through the service answers `stale_detail` instead of serving stale snapshot bytes with a snapshot revision.
- `project` execution now picks the first detected brand that defines the requested action when no `brand` is pinned, validates the host runner's outcome shape (`exitCode` integer, string streams, non-negative `durationMs`) and maps a malformed outcome to `internal_error`.
- `globalToolLeaves` looked global names up in the workspace leaf table, which never matched, so every `amp_tool_global_*` call answered `unknown_tool`. The map is now derived from the workspace descriptors, and the global mirror dispatches capabilities, reactive, diff, project and filesystem-style tools; `workspaceAgentCheck` covers a global reactive/diff/project round trip.
- `diff_read` now derives a file's `revision` and its byte/line metrics from the same text, so a file written through the service reports the writer's revision instead of mixing post-write content with the stale snapshot revision.
- Invalid UTF-8 bytes in `src/semantic/canonical.ts`, `src/fingerprint/file.ts` and `src/fingerprint/tree.ts` (broken em dashes) were repaired, so strict decoders and `read` no longer reject those sources.
- Office outline ranges now map document-order sections proportionally to container bytes instead of collapsing every section to `0..0`; `fileOutlineCheck` covers it.
- Office files no longer fail import/export/dependency with `binary_file`; hyperlinks, external links, formulas and embedded objects become external edges.
- Hashing a string with an unpaired surrogate produced the same digest as `U+FFFD`, because `TextEncoder` substitutes it. `rawTextHex`, `fingerprintString` and strict canonical JSON now reject the input instead of collapsing two different values.
- Directory content digests were computed from `readFile(path, "utf8")`, so files that are not valid UTF-8 (for example `0x80` and `0x81`) decoded to the same replacement character and shared a digest. They are now hashed as bytes.

## [0.4.2] - 2026-10-29

### Fixed

- `attention-manifest-protocol/window` now exports ledger compaction and pruning: `planPrune`, `compactLedger`, `verifyCompaction`, `CompactionRefused`, `PruneResult`, `Compaction`, `CompactionOptions`, and the policy types `PrunePolicy`, `PrunePlan`, `PruneDecision`, `PruneReason`, `Checkpoint` and `LedgerKind`. They compiled into `lib/` but were absent from the barrel, so only the deep `window/compaction.js` path could reach them.

### Changed

- Both READMEs document compaction and pruning as an architecture component, with the ledger and concept entry points named.

## [0.4.1] - 2026-10-29

Published library build: the package now exposes importable ESM with types.

### Added

- `npm run build:lib` emits ESM and declaration files to `lib/`; `prepublishOnly` rebuilds them before every publish.
- `exports` maps the root entry (`lib/index.js`), per-module subpaths, deep module files and `schemas/*`; `main`, `types` and the `types` conditions cover both `nodenext` and bundler resolution.
- Module barrels for the remaining `src/` directories, so every module imports through a single path.

### Fixed

- Declarations now carry JavaScript specifier extensions. `tsc` rewrites relative `.ts` imports only for `.js` output, so `tools/rewriteDeclarationExtensions.ts` rewrites the `.d.ts` files and fails the build if a TypeScript extension survives.

## [0.4.0] - 2026-10-29

Governance v0.4: persistence, key rotation and real HTTP interoperability.

### Added

- A real HTTP server (`src/governance/httpServer.ts`): localhost, method/path/body limits,
  end-to-end authentication with `HttpCooperationTransport`; `cooperation-http-check` has 3 checks.
- Key rotation (`GovernanceKeyring.rotate/revokeKid/prune`): signatures made before rotation remain
  valid during the overlap window and an old kid can be revoked; `signing-check` is now 5 checks.
- Audit checkpoints (`checkpoint/verifyCheckpoint/entriesAfter`): a retained segment verifies
  independently; `audit-check` is now 4 checks.
- Governance object store (`src/governance/store.ts`): manifests, credentials and receipts are
  appended to a JSONL event log and the latest state is replayed on reopen;
  `governance-store-check` has 1 check.
- DeepSeek paired samples expanded to 20: rubric 20/20, judge 4.85/5, paired token delta +6.9%,
  about $0.007547, boundaries 20/20.

## [0.3.0] - 2026-10-28

Governance v0.3: Ed25519 signing, durable audit, authenticated transport and a pre-execution tool gate.

### Added

- Ed25519 signing adapter (`src/governance/signing.ts`): `GovernanceSignatureBundle` binds
  signer/subject/id/version/digest and `GovernanceKeyring` supports revocation; `signing-check`
  covers transplant, missing, duplicate and revoked signatures.
- Durable audit: `src/storage/fileAppendSink.ts` provides a JSONL file sink; `audit-check` now
  reopens the chain across processes and rejects on-disk tampering (3 checks).
- HTTP transport authentication: Ed25519 signatures, clock skew and nonce replay protection;
  `cooperation-check` is now 14 checks.
- Pre-execution tool gate (`src/governance/toolPolicy.ts`): `GovernedToolPolicy` checks
  high-risk approval, freeze/breaker and the evidence floor before the executor runs;
  `tool-gate-check` has 4 checks.
- DeepSeek evaluation expanded to 20 quality and 20 boundary cases: rubric 20/20, judge
  4.85/5, paired token delta +6.2%, about $0.004095; the report is
  `docs/probes/governance-live.json`.
\n## [0.2.0] - 2026-10-28

Governance v0.2: auditable, transportable and measurable, with a green verification chain.

### Added

- The attention-governance layer (`src/governance/`). It implements the nine constructs of the
  Attention Manifest Protocol description: the scenario × mode matrix (all tables from
  9.1–9.8), the perspective registry, signed attention manifests, the three-layer context,
  triple-signed switch credentials, the Bayesian control layer, the legal behaviour layer
  (freeze, downgrade, breaker), the three-ledger budget and the seven-phase approval
  workflow. It reconciles the description's T1/T2/T3 strictness order with AMP's existing
  T0–T4 strength order (`F1→T3`, `F2→T2`, `F3→T1`) and keeps explicit bridges from the eight
  legacy scenarios to the five canonical ones and from `inspire` to `diverge`.
- `docs/governance.md`, `governance.schema.json` (manifest and credential) and two validatable
  examples (`attention-manifest.json`, `switch-credential.json`).
- `tools/governanceCheck.ts` (19 assertions) and `tools/governedTaskCheck.ts` (5
  assertions), both wired into `npm run verify`.
- `src/runtime/governedTask.ts`: manifest verification, credential validation, legal audit,
  ledger charge, board receipt and control decision wrapped around `CognitiveRuntime`.
  Refusal paths return before the model call. A live `deepseek-chat` governed turn has been
  run end to end.
- Agent budget ledgers and `reallocate()`: budgets now support `scope: "agent"`; a sub-agent's
  quota is transferred from its parent with the total conserved. Negative/NaN/Infinity amounts
  are rejected, reserve charges require finance approval, and a draw above 50% also needs the board.
- Perspective-switch orchestration (`src/governance/switching.ts`): peer switch, downgrade,
  mode switch, scenario re-derivation and the escalation plan. A scenario switch calls
  `rederiveAttentionManifest()`, increments the version and records the parent digest.
- Multi-agent cooperation (`src/governance/cooperation.ts`): structured messages (manifest
  summary, refs, credential, receipt), receiver-side credential verification, an independent
  supervisory audit path, and communication pruning by reliability × information value.
- Multi-agent transport seam (`src/governance/transport.ts`): `LoopbackTransport`,
  `HttpCooperationTransport` and `createCooperationHandler()`. The receiver always re-runs the
  digest/manifest/credential/receipt checks; malformed envelopes are 400, policy rejections 422
  and success 200. `cooperation-check` is now 13 checks.
- Governance audit chain (`src/governance/audit.ts`): manifests, credentials, receipts, charges,
  legal orders, workflow transitions, switches and runtime turns can be appended to a hash-linked
  append-only log; `verify()` detects edits, reordering and truncation, and `open({ sink })`
  verifies the whole chain on reopen. `GovernedTask` accepts an `audit` and appends a
  `runtime.turn` record after settlement.
- `tools/auditCheck.ts` (2 checks) covers cross-object records, reopen, tampering and corruption;
  wired into `npm run verify`.
- `tools/cooperationCheck.ts` (13 checks) wired into `npm run verify`; `governance-check` is
  now 21 checks, including regressions for forged signatures, negative amounts, freeze
  revocation, the archive gate, control NaN, unknown effects and private-context leakage.
- `tools/liveGovernanceEval.ts` (`npm run governance-live`) with DeepSeek quality, token and
  boundary evaluation. Quality uses a deterministic rubric plus a strict judge; tokens record
  input/output/cache/cost, ledger charge and cap; boundaries cover crisis escalation, expired
  manifest, stale credential, legal freeze, budget exhaustion, prompt-injection leakage and
  multi-agent scope/size limits. The report lands in `docs/probes/governance-live.json`; the
  key is read from the environment only. First run: 6/6 rubric, judge 4.83/5, matched token
  delta +3.8%, boundaries 9/9.
- `GovernedTask` now maps the manifest's scenario and modes into the runtime's
  scenario/interaction budgets, injects the manifest summary, evidence floor and forbidden
  behaviours as a `systemNote`, charges the manifest's `perspective`/`agent` ledger, and checks
  for a frozen ledger before generation.
- Construction boundary (`src/boundary/`). `frameFrom()` validates the id grammar, reference
  closure, the 9-slot ceiling, the exclusion cap (default 50, overflow returned as `deferred`)
  and budget consistency before a frame exists; `parseToolCall()` validates arguments against a
  JSON Schema subset and returns a digest of exactly what was accepted; `RefTable` gives `tool`
  and `capability` one namespace and resolves `self`. 19 assertions run as
  `npm run boundary-check` and inside `npm run verify`.
- `ExecProfile` parses call arguments through `parseToolCall()` before policy evaluation and
  dispatch. A rejected argument set records a blocked receipt and never reaches a server;
  approvals bind to the parsed digest.
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
- `tools/compactionCheck.ts` with 15 assertions, wired into `npm run verify`.
- Concept economy. `pruneConcept()` bounds one concept's content: duplicate examples collapse
  to the more typical one, examples beyond `maxExamples` go from the least typical end, and
  the floor (`minExamples`) keeps the concept grounded. Relations are de-duplicated, dangling
  targets are dropped when a resolver is supplied, and the extension is de-duplicated. The
  definition, intension, counterexamples and `grounded_in` are never trimmed, and a view never
  bumps `version`.
- `compactConceptHistory()` keeps the head plus `keepVersions` and commits the rest into a
  `concept-checkpoint`. It refuses a broken version lineage or a window that covers every
  version. Invariants C-1 to C-4 are documented in `docs/compaction.md` §6.
- `concept-compaction.schema.json`, two worked examples, and `tools/conceptCheck.ts`
  (14 assertions) wired into `npm run verify`.
- `src/structure/priority.ts`: a stable `PriorityQueue` over a comparison heap, an
  `IndexedPriorityQueue` that re-prioritises and deletes by key in O(log n), a `BucketQueue`
  for integer priorities with one FIFO bucket per priority, and `TopK` for bounded
  selection. `tools/priorityCheck.ts` runs 27 cases, including randomised differential
  checks against stable-sort models, as `npm run priority-check` and inside `npm run verify`.

### Changed

- Counts moved with the new layer: schemas 14 → 16, validated example objects 33 → 37,
  verification entries 29 → 31, TypeScript scripts under `tools/` 38 → 40.
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
- Licence changed from `UNLICENSED` to Apache-2.0. A verbatim copy of the licence is at the
  repository root, `package.json` and `package-lock.json` declare `Apache-2.0`, and both
  READMEs state the grant and the conditions a redistribution has to meet.
- Attribution: a `NOTICE` file records the copyright holder (Eloy Kim, 2026) and must be
  kept by redistributions, `package.json` names the author, and both READMEs link the
  licence and the notices.

### Fixed

- The audit gate was unsatisfiable: `audit.behavior` and `audit.budget` had no approving
  department. Legal now owns `audit.behavior` and finance owns `audit.budget`, so the audit
  phase can advance to escalation or archive.
- `src/bayes/calibration.ts` left unused `item` parameters in the `filter` callbacks of the
  cross-validation split, which made `tsc --noEmit` fail; the parameters were renamed with no
  behavioural change.
- `package.json` had a corrupted UTF-8 fragment in `description` (`T0閳ユ彑4`), now `T0-T4`; the
  `demo` script pointed at the long-deleted `src/cycle/demo.ts` and was removed, with the
  README pointing at the runnable governance checks instead.
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
