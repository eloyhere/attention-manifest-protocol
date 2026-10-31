# Attention Manifest Protocol (AMP)

**English** · [简体中文](README.zh-CN.md) · [Changelog](CHANGELOG.md)

AMP is a metacognitive protocol for agents: declare knowledge and obligations, allocate finite attention, obtain evidence, and record costs and outcomes. The reference implementation is version `0.4.2`, requires **Node.js 24 or later**, and uses Apache-2.0.

## Architecture

| Component | Responsibility |
| --- | --- |
| Warrant Ledger | Claims, evidence, hypotheses, unknowns, concepts and plans: why believe a conclusion? |
| Attention Ledger | Frames, budgets, receipts and interruptions: where was attention spent? |
| Manifest | Durable, signable identity, capabilities, commitments and limits |
| Assignment | Bind duties, authority, budget and interaction contracts to agents |
| Attention | Select candidates and record why they matter |
| Frame | Freeze one allocation with refs, budgets and explicit exclusions (`ignored`) |
| Context | Materialize summaries, relations and bounded detail access |
| Session | Bearer-bound identity, roots, permissions, TTL and context isolation |
| Filesystem | File/Directory tree, paged reads/writes, outlines, import/export/dependency graphs and Office parsing |
| Hook | Agent-facing composition: `useRead`/`useWrite`/`useDiff`/`useParse`/`useOutline`, read-only except write |
| Receipt | Record actual costs and outcomes for audit and calibration |
| Compaction | Prune cold or superseded objects with a reason, then replace a verified prefix with a checkpoint |
| Fingerprint | One definition of what a digest covers; algorithm and normalisation policy travel with the digest |
| Naming | One grammar for protocol, service and tool identity, with a parser and a catalog digest |

```text
Attention → Frame → Context → Receipt → Ledger
```

Context combines a structural tree and typed relationships. Project dependencies, imports, calls and references are descriptive and may contain cycles; `depends` separately denotes prerequisites. Relations do not automatically widen a Frame. Summaries retain provenance/revision information; content-addressed detail reads verify hashes. Structure and provenance do not by themselves prove factual correctness.

## Implemented capabilities

- T0–T4 evidence tiers, confidence limits, revision, falsifiability, preregistration and abstention.
- Budgeted attention, explicit exclusions, interrupts, leases, delegation and merge/arbitration.
- Responsibility and interaction assignment: RACI-style duty bindings with authority/budget/window attenuation, acceptance, evidence-based discharge and cascade revoke; interaction contracts with protocol roles, mode mix, cadence, escalation and handoff.
- Signed manifests/credentials, governance workflows, tool gates, authenticated local/HTTP communication, audit chains and persistence adapters.
- MCP execution, schema-validated arguments, digest pinning and legacy fallback; A2A discovery and messages.
- Project trees, project dependency graphs, partial TS/JS import/call/reference graphs and lexical knowledge retrieval.
- Agent workspace: a `File`/`Directory` tree (fingerprint, charset, bigint lines/bytes, timestamps, description/summary/purpose); paged reads, CAS atomic writes, strategy-based outlines (code/project/prose/Office); import/export/dependency graphs (Tarjan SCC, topological order, bounded closure); Session identity and context isolation; a `src/hook` composition layer; SQLite entities and repositories.
- Host discovery: one structural tree over authorized projects, internal modules (service/tool/controller/route/repository/model/config/test/...), file names, bounded content matches, and host-registered plugins/services/tools. Project nodes carry description, purpose and summary.
- Structured Markdown/TXT/DOCX/XLSX/PPTX and TeX/LaTeX/BibTeX input with native source locations and summary/detail separation.
- `amp_protocol_workspace` v1 agent service, eight tools, local runtime integration and MCP stdio.
- Fingerprints with an explicit policy: RFC 8785 canonical JSON for values, byte-level hashing for files, domain-separated Merkle roots for directory trees, and a `verify` that compares algorithm, kind and policy instead of a bare hex string. Unpaired surrogates and `-0` are rejected rather than silently rewritten.
- One naming table for protocol, service and tool identity (`amp_protocol_*` / `amp_service_*` / `amp_tool_*`) with a grammar, a parser and a signed catalog digest, so dispatch, pinning and audit share one spelling.
- Compaction and pruning at two levels. `planPrune()` decides every drop with a reason and a revisit condition; `compactLedger()` replaces a verified cold prefix with a checkpoint, `verifyCompaction()` re-derives that commitment, and compaction refuses to bury an entry the retained tail still cites. `pruneConcept()` and `compactConceptHistory()` apply the same discipline to concept content and version history.

Offline parsers live in `tools/support/`. The runtime stays database-free and uses ports; persistence adapters are separate. Concrete contracts remain in [schemas](docs/schemas/), [examples](docs/examples/) and executable [checks](tools/).

### Responsibility and interaction

`responsibility-assignment` binds duties, RACI, authority, budget, window and evidence to an assignee; `interaction-binding` fixes the parties, protocol roles, mode mix, cadence, escalation and handoff state for a conversation. Both are checked by `assignment-check` and `interaction-binding-check`, and their contracts live in [docs/schemas](docs/schemas/). `AssignmentLedger`'s `onRevoke` hook can call `BindingLedger.revokeForAssignment()` so an assignment revocation cascades to its bindings.

### Discovery

`amp_tool_workspace_discover` returns one structural tree over the authorized projects. File nodes carry a module kind (`service`, `tool`, `controller`, `route`, `repository`, `model`, `config`, `test`, `middleware`, `component`, `util`), an extension and bounded content matches. Hosts register project descriptions, purposes, summaries, plugins, services and tools through `HostCatalog`; project metadata is attached to project nodes, and an unregistered project falls back to its workspace summary. Discovery is read-only, never widens `projectIds`, and returns snippets as discovery evidence rather than as a Frame-allocated detail read.

## Quick start

```sh
npm ci
npm run build
npm run verify
npm run scenario
```

## Library usage

`npm install attention-manifest-protocol` ships the compiled ESM build in `lib/` with its declarations, alongside the source, JSON Schemas and executable checks. Node.js 24 or later is required. The root entry exposes the documented protocol surfaces; every module is also reachable as a subpath.

```js
import { generateSigningKey, signManifest, verifyManifest } from "attention-manifest-protocol";
import { Ledger } from "attention-manifest-protocol/ledger";
import { sha256Hex } from "attention-manifest-protocol/semantic/sha256.js";
import { fingerprintText, fingerprintTree, verify } from "attention-manifest-protocol/fingerprint";
import { ToolIds, parseId } from "attention-manifest-protocol/naming";
```

| Specifier | Resolves to |
| --- | --- |
| `attention-manifest-protocol` | `lib/index.js`: attention, assignment, context, discover, frame, ledger, manifest, receipt and warrant |
| `attention-manifest-protocol/<module>` | `lib/<module>/index.js` for every module under `src/` |
| `attention-manifest-protocol/<module>/<file>.js` | one compiled module |
| `attention-manifest-protocol/schemas/<name>.json` | the JSON Schema from `docs/schemas/` |

`npm run build:lib` rebuilds `lib/` and `prepublishOnly` runs it before publishing. The build compiles only the library; the Vite demo entry (`src/main.ts`) is not part of it.

Focused checks: `npm run workspace-agent-check`, `workspace-project-check`, `workspace-diff-check`, `workspace-reactive-diff-check` and the `workspace-*-boundary-check` suites, `workspace-context-check`, `document-context-check`, `tex-context-check`, `governance-check`, `assignment-check`, `interaction-binding-check`, `discover-check`, `discover-agent-check`, `typecheck` and `typecheck:tools`. `verify` runs the full chain and both type checks. Evaluation inputs/reports remain in [docs/eval](docs/eval/) and [docs/probes](docs/probes/) as JSON; fixture and recorded-probe results are not independent human studies or production-quality evidence.

## Agent tools

The `amp_protocol_workspace` v1 response contains `protocol`, `version`, `revision`, `ok`, and either `data` or `error`. Both adapters share input schemas; the [protocol types](src/protocol/workspace.ts) define the response envelope. Except capability discovery, each business tool requires the current `revision`. Tool names come from the frozen naming table in [`src/naming/`](src/naming/); the pre-0.5 `amp_workspace_*` spellings are still accepted as input aliases and are listed under `deprecatedAliases` in the capabilities response. Every workspace tool is also mirrored as `amp_tool_global_<leaf>` over the host's complete authorized project set.

| Tool | Purpose |
| --- | --- |
| `amp_tool_workspace_capabilities` | Discover permitted projects, registered Frames, tools and limits |
| `amp_tool_workspace_tree` | Page project roots or structural children with native source locations |
| `amp_tool_workspace_query` | Retrieve candidate IDs by lexical AND search and bounded graph traversal |
| `amp_tool_workspace_relations` | Page typed dependency/call/reference relations and sources |
| `amp_tool_workspace_discover` | Return one structural tree of authorized projects, modules, file names, bounded content matches and host components |
| `amp_tool_workspace_materialize` | Materialize a host-registered Frame into a bounded Context |
| `amp_tool_workspace_read` | Page a CAS-verified detail by character offset, 1-based lines or UTF-8 bytes; carries `importation`/`exportation`, the relative files it imports and the relative files importing it |
| `amp_tool_workspace_write` | Replace project content by whole node, line range or UTF-8 byte range; host-gated, CAS and dry-run; returns the same `importation`/`exportation` |
| `amp_tool_workspace_project` | Detect the project brand from manifest/lockfile evidence and run one host-approved `build`/`compile`/`run`/`test` command |
| `amp_tool_workspace_outline` | One cascading outline: project → directory → file → symbol/knowledge, with 1-based ranges and bounded depth |
| `amp_tool_workspace_dependency` | Project-level dependencies and dependents with the declaring source and method |
| `amp_tool_workspace_reactive_read` | Proxy-backed workspace tree whose properties materialize lazily and are cached |
| `amp_tool_workspace_reactive_write` | Set a node property (`summary`/`label`/`tags`) and refresh the affected cache; `content` uses the guarded write path |
| `amp_tool_workspace_diff_read` | Comparable project tree carrying content revisions and byte/line metrics |
| `amp_tool_workspace_diff_write` | Whole-file, 1-based line-splice or UTF-8 byte-splice write with the resulting line diff and hunks |
| `amp_tool_workspace_release` | Release a read handle without refunding or reopening its Frame |

`read` and `write` both need an explicitly allocated, materialized target; ancestors and discovery snippets do not grant it. `importation` lists the relative files the target's file imports (bare specifiers go to `external`, whose `externalTotal`/`externalTruncated` make the `maxFileLinks` cut visible) and `exportation` lists the relative files that import it, so an edit can be scoped without a second relation query. After a write to a file, a symbol or knowledge page extracted from it answers `stale_detail` until the host refreshes the snapshot, so stale bytes are never served with a current-looking revision. `write` never touches the file system itself: the host supplies a write port in `WorkspaceServiceOptions.writer`, and without one the call fails with `write_unavailable` while `dryRun` still previews the edit.

`project` detection is offline (manifest and lockfile file names only); an execution action hands exactly one command from the brand table to `WorkspaceServiceOptions.runner`, and the agent can never supply command text. `reactive_read`/`reactive_write` add a per-service annotation overlay and child-index cache: a write bumps `cacheVersion` and reports every invalidated ancestor. `diff_read` exposes the content revision of each file so two snapshots can be compared without bodies; `diff_write` applies whole-file, line or byte splices and returns the resulting hunks, reusing the write port, CAS and dry-run.

### Filesystem tools

`amp_tool_filesystem_*` is bound to one authenticated Session; the bearer token never appears in a tool argument. Every tool except `write` is read-only.

| Tool | Purpose |
| --- | --- |
| `amp_tool_filesystem_session` | Current identity, roots, permissions, remaining TTL and quotas |
| `amp_tool_filesystem_file` | One File/Directory node; `depth`/`offset`/`limit` bound the subtree |
| `amp_tool_filesystem_directory` | Flat listing of direct children |
| `amp_tool_filesystem_read` | 1-based line page with fingerprint, charset and the next line |
| `amp_tool_filesystem_write` | Atomic write; create/overwrite/upsert/append, CAS, dry-run |
| `amp_tool_filesystem_outline` | Structural outline with `query`/`startLine`/`endLine` filters |
| `amp_tool_filesystem_import` | Outgoing, incoming or two-way imports |
| `amp_tool_filesystem_export` | Exported symbols, signatures and re-export edges |
| `amp_tool_filesystem_dependency` | Cycles, topological order and bounded closures |
| `amp_tool_filesystem_ast` | Lossless syntax tree: every non-whitespace token, declaration/markup hierarchy, UTF-8/line ranges; read-only, never executes |

The global variant is `amp_tool_globalfs_*`, a naming adapter in [src/global/filesystem.ts](src/global/filesystem.ts) that grants no new root or permission. Outline nodes carry `isFile`/`isDirectory`/`file?`/`directory?`/`path` (for example `add.py#add`) and `range` (UTF-8 bytes plus 1-based lines as bigint; decimal strings on the wire). Strategies cover code, Vue, project manifests, Markdown/TeX/plain text, CSS/SCSS/Sass, HTML, XML/OPML and Office; Office parsing covers DOCX/XLSX/PPTX and treats DOC/XLS/PPT/PUB/ACCDB as best-effort CFB.

### Hooks

`src/hook` packages the same read-only operations as stateful, subscribable composition functions; only `useWrite` mutates:

```ts
import { useRead, useWrite, useDiff } from "attention-manifest-protocol/hook";

const read = useRead(session);
await read.run({ path: "src/main.ts", maxLines: 80, includeLineNumbers: true });
const write = useWrite(session);
await write.run({ path: "src/new.ts", content: "export const value = 1;\n", mode: "create" });
const diff = useDiff(session);
await diff.run({ path: "src/new.ts", before: "" });
```

`useParse` is module-specific (`useOutlineParse`, `useImportationParse`, `useExportationParse`, `useDependencyParse`, `useCodeParse`, `useProjectParse`, `useAstParse`); `useCode`/`useProject` are composed models and `useAst` returns the lossless read-only syntax tree. A cache hit re-checks the session revision, and runs can be recorded in `hook_runs`.

### MCP stdio

```sh
npm run workspace-agent-demo
npm run workspace-agent -- --config .cache/workspace-agent.local
```

For an MCP client, start Node directly to keep package-manager banners out of stdout. Replace absolute paths with your checkout location:

```json
{
  "mcpServers": {
    "amp-workspace": {
      "command": "node",
      "args": [
        "R:/project/attention-manifest-protocol/tools/workspaceAgentServer.ts",
        "--config",
        "R:/project/attention-manifest-protocol/.cache/workspace-agent.local"
      ]
    }
  }
}
```

The trusted host bootstrap contains `version: 1`, `agentId`, explicit `projectIds`, a `WorkspaceSnapshot`, `contents` mapping CAS refs to text, `frames`, optional lower `limits`, and optional `discovery.projects` / `discovery.components` for host-registered descriptions and components. Contents are hash-checked at startup. The demo uses example inputs; real hosts pass their authorized inventory to `scanStructuredWorkspace` in [documentScanner.ts](tools/support/documentScanner.ts).

The stdio adapter reads configuration only at startup; new snapshots/Frames require a new host configuration and instance. It accepts newline-delimited JSON-RPC, limits messages to 1 MiB and configuration to 64 MiB, and never executes tools carried in notifications. It supports `initialize` for `2025-11-25` / `2025-06-18` and the repository's `2026-07-28` stateless discovery/metadata profile; other versions are not claimed as tested.

### Local runtime

```ts
import { WorkspaceAgentService } from "./src/context/index.ts";
import { ToolRegistry, registerWorkspaceTools, WorkspaceToolExecutor } from "./src/module/index.ts";

const workspace = new WorkspaceAgentService({
    agentId: frame.agent,
    projectIds: ["project:packages/app"],
    snapshot,
    store,
});
workspace.registerFrame(frame, snapshot.revision);
const tools = new ToolRegistry();
registerWorkspaceTools(tools, workspace);
const toolExecutor = new WorkspaceToolExecutor(workspace, existingExecutor);
```

The host provides the Frame, snapshot, ContentStore and fallback executor; pass `tools` / `toolExecutor` to `CognitiveRuntime`. Registration, revocation and Receipt settlement are host APIs, unavailable to the model.

### Scope, lifecycle and limits

Discovery/query return metadata and candidates, not authorization. Hosts fix project scope and register selected Frames. Only active targets admitted to the view permit detail reads; ancestor summaries do not grant whole-file access. Workspace IDs are extension-local keys, not global Ledger identities. Full Frame validation, signatures and policy checks remain host responsibilities.

Identical materialization requests reuse a Context without recharging summaries; changed parameters are rejected. Release/revocation invalidates the read handle but retains pending settlement. Hosts use `pendingSettlements()` and `settle(contextId, receipt)` to obtain an archived ContextSnapshot. This state is in memory; hosts must persist audit/recovery data.

Defaults: 128 registered Frames, 32 live read Contexts, 8000 estimated summary tokens, 8000 UTF-16 units per detail page, 131072 units per successful response and 1000 business calls. Query depth is at most 10; results/pages at most 100. Hosts may lower limits. Summary text and successful detail pages share the Frame's remaining estimated token budget; repeat reads cost budget and release does not refund it. Discovery, JSON wrapping and later model consumption are excluded from that estimate; actual usage belongs in Receipts.

Detail offsets use UTF-16 units; `nextOffset: null` ends pagination. Reassemble structured JSON detail before parsing. CAS verification reads the full detail before paging, so response bounds do not imply bounded storage I/O. Runtime messages retain complete JSON up to `maxToolResultChars` (default 1048576, configurable down to 128); oversize results return `tool_result_too_large`, while logs retain a 4000-character preview.

Service errors: `invalid_arguments`, `unknown_tool`, `revision_mismatch`, `not_available`, `frame_unavailable`, `budget_exhausted`, `capacity_exceeded`, `response_too_large`, `integrity_failure`, `internal_error`. Oversize responses fail instead of truncating structured content.

## Repository layout

| Path | Contents |
| --- | --- |
| [src/semantic](src/semantic/) | Base primitives with no policy: strict SHA-256, canonical JSON and the I-JSON predicate |
| [src/fingerprint](src/fingerprint/) | Algorithms, preimage framing, policies, refs, verification, files and Merkle trees |
| [src/naming](src/naming/) | The frozen id table, the id grammar, compatibility aliases and the catalog digest |
| [src/context](src/context/) | Context lifecycle, tree/graph projections, CAS, workspace facts, context assembly and agent service |
| [src/session](src/session/) | Identity, tokens, TTL, context isolation, fork/revoke/rotate |
| [src/file](src/file/) | File/Directory tree, metadata, paged reads, atomic writes, session runtime/service, module graphs and ZIP/CFB containers |
| [src/syntax](src/syntax/) | Charset detection/encoding, byte/line indexing, syntax registry and lossless read-only syntax trees |
| [src/outline](src/outline/) | Code/document outlines, range and label indexes, keyword/strategy registries, React/Shell/SQL/Visual Basic strategies and Office parsing |
| [src/hook](src/hook/) | Agent-facing composition hooks and run records |
| [src/protocol](src/protocol/) | Wire contracts: envelopes, A2A, channels and the `amp_protocol_workspace` surface |
| [src/module](src/module/) | LLM/tool ports, MCP adapters and execution policies |
| [src/runtime](src/runtime/) | Agent turn/tool loop and governance integration |
| [src/governance](src/governance/) | Manifests, credentials, budgets, workflows, signing and audit |
| [src/structure](src/structure/) | Maps, trees, queues, priority indexes, filters, AST and LRU |
| [src](src/) | Other attention, evidence, ledger, policy, kernel and persistence domains |
| [tools](tools/) | TypeScript checks, offline scanners, demos and probes |
| [docs/schemas](docs/schemas/) / [docs/examples](docs/examples/) | Machine-readable contracts and protocol examples |
| [docs/eval](docs/eval/) / [docs/probes](docs/probes/) | Evaluation inputs and JSON reports |

## Code style

ESLint checks semantic/style constraints; Prettier handles layout. Commands: `npm run lint`, `lint:fix`, `format:check`, `format`, `style-check`. Configuration lives in [eslint.config.mts](eslint.config.mts) and [prettier.config.mts](prettier.config.mts); local rules/printer live under `tools/`.

Declare variable types explicitly; use arrow functions instead of `function`, semicolons, four-space indentation, double quotes and template strings. Keep parameters/type parameters on one line, use braces for control flow, `typeof(value)` and `=== (void 0)`. Locals/parameters and function values use lowerCamelCase; module-level data uses PascalCase; source file names use lowerCamelCase starting with a lowercase letter (for example `workspaceService.ts`, `fileGraph.ts`) and never hyphens, while SQL identifiers keep the existing snake_case. Comments use multiline JSDoc except tool directives. Historical files retain lint/format migration debt; functional verification does not imply a clean repository-wide style check.

## Boundaries and evidence

Static dependency extraction is partial; missing edges do not prove independence. Markdown/TeX scanners do not implement all macros or semantics. Summaries, graphs and long contexts require multi-hop, cross-document and changing-information evaluations. Relevant primary sources include [LaRA](https://proceedings.mlr.press/v267/li25dv.html), [GraphRAG-Bench](https://arxiv.org/abs/2506.05690), [Tree-sitter](https://tree-sitter.github.io/tree-sitter/) and [RFC 6920](https://www.rfc-editor.org/rfc/rfc6920.html); they do not establish AMP's own effectiveness.

Sandbox isolation, multi-tenancy, interactive OAuth, production deployment and real external-agent interoperability remain outside the completed reference implementation. Human research inspires design but does not prove identical model mechanisms or capacity constants. Provenance proves integrity, not truth or authority to act.

## License and history

[Apache License 2.0](LICENSE), copyright 2026 Eloy Kim; retain [NOTICE](NOTICE), license and attribution notices when redistributing. History: [CHANGELOG.md](CHANGELOG.md) and [CHANGELOG.zh-CN.md](CHANGELOG.zh-CN.md).
