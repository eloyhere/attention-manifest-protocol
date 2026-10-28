# Attention Manifest Protocol (AMP)

**English** · [简体中文](README.zh-CN.md) · [Changelog](CHANGELOG.md)

AMP is a metacognitive protocol for agents: declare knowledge and obligations, allocate finite attention, obtain evidence, and record costs and outcomes. The reference implementation is version `0.4.0`, requires **Node.js 24 or later**, and uses Apache-2.0.

## Architecture

| Component | Responsibility |
| --- | --- |
| Warrant Ledger | Claims, evidence, hypotheses, unknowns, concepts and plans: why believe a conclusion? |
| Attention Ledger | Frames, budgets, receipts and interruptions: where was attention spent? |
| Manifest | Durable, signable identity, capabilities, commitments and limits |
| Attention | Select candidates and record why they matter |
| Frame | Freeze one allocation with refs, budgets and explicit exclusions (`ignored`) |
| Context | Materialize summaries, relations and bounded detail access |
| Receipt | Record actual costs and outcomes for audit and calibration |

```text
Attention → Frame → Context → Receipt → Ledger
```

Context combines a structural tree and typed relationships. Project dependencies, imports, calls and references are descriptive and may contain cycles; `depends` separately denotes prerequisites. Relations do not automatically widen a Frame. Summaries retain provenance/revision information; content-addressed detail reads verify hashes. Structure and provenance do not by themselves prove factual correctness.

## Implemented capabilities

- T0–T4 evidence tiers, confidence limits, revision, falsifiability, preregistration and abstention.
- Budgeted attention, explicit exclusions, interrupts, leases, delegation and merge/arbitration.
- Signed manifests/credentials, governance workflows, tool gates, authenticated local/HTTP communication, audit chains and persistence adapters.
- MCP execution, schema-validated arguments, digest pinning and legacy fallback; A2A discovery and messages.
- Project trees, project dependency graphs, partial TS/JS import/call/reference graphs and lexical knowledge retrieval.
- Structured Markdown/TXT/DOCX/XLSX/PPTX and TeX/LaTeX/BibTeX input with native source locations and summary/detail separation.
- `amp.workspace` v1 agent service, seven tools, local runtime integration and MCP stdio.

Offline parsers live in `tools/support/`. The runtime stays database-free and uses ports; persistence adapters are separate. Concrete contracts remain in [schemas](docs/schemas/), [examples](docs/examples/) and executable [checks](tools/).

## Quick start

```sh
npm ci
npm run build
npm run verify
npm run scenario
```

Focused checks: `npm run workspace-agent-check`, `workspace-context-check`, `document-context-check`, `tex-context-check`, `governance-check`, `typecheck` and `typecheck:tools`. `verify` runs the full chain and both type checks. Evaluation inputs/reports remain in [docs/eval](docs/eval/) and [docs/probes](docs/probes/) as JSON; fixture and recorded-probe results are not independent human studies or production-quality evidence.

## Agent tools

The `amp.workspace` v1 response contains `protocol`, `version`, `revision`, `ok`, and either `data` or `error`. Both adapters share input schemas; the [protocol types](src/context/workspaceProtocol.ts) define the response envelope. Except capability discovery, each business tool requires the current `revision`.

| Tool | Purpose |
| --- | --- |
| `amp_workspace_capabilities` | Discover permitted projects, registered Frames, tools and limits |
| `amp_workspace_tree` | Page project roots or structural children with native source locations |
| `amp_workspace_query` | Retrieve candidate IDs by lexical AND search and bounded graph traversal |
| `amp_workspace_relations` | Page typed dependency/call/reference relations and sources |
| `amp_workspace_materialize` | Materialize a host-registered Frame into a bounded Context |
| `amp_workspace_read` | Read a CAS-verified detail page for an explicitly allocated visible target |
| `amp_workspace_release` | Release a read handle without refunding or reopening its Frame |

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
        "R:/project/attention-manifest-protocol/tools/workspace-agent-server.ts",
        "--config",
        "R:/project/attention-manifest-protocol/.cache/workspace-agent.local"
      ]
    }
  }
}
```

The trusted host bootstrap contains `version: 1`, `agentId`, explicit `projectIds`, a `WorkspaceSnapshot`, `contents` mapping CAS refs to text, `frames`, and optional lower `limits`. Contents are hash-checked at startup. The demo uses example inputs; real hosts pass their authorized inventory to `scanStructuredWorkspace` in [documentScanner.ts](tools/support/documentScanner.ts).

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
| [src/context](src/context/) | Context lifecycle, tree/graph projections, CAS, workspace facts and agent service |
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

Declare variable types explicitly; use arrow functions instead of `function`, semicolons, four-space indentation, double quotes and template strings. Keep parameters/type parameters on one line, use braces for control flow, `typeof(value)` and `=== (void 0)`. Locals/parameters and function values use lowerCamelCase; module-level data uses PascalCase. Comments use multiline JSDoc except tool directives. Historical files retain lint/format migration debt; functional verification does not imply a clean repository-wide style check.

## Boundaries and evidence

Static dependency extraction is partial; missing edges do not prove independence. Markdown/TeX scanners do not implement all macros or semantics. Summaries, graphs and long contexts require multi-hop, cross-document and changing-information evaluations. Relevant primary sources include [LaRA](https://proceedings.mlr.press/v267/li25dv.html), [GraphRAG-Bench](https://arxiv.org/abs/2506.05690), [Tree-sitter](https://tree-sitter.github.io/tree-sitter/) and [RFC 6920](https://www.rfc-editor.org/rfc/rfc6920.html); they do not establish AMP's own effectiveness.

Sandbox isolation, multi-tenancy, interactive OAuth, production deployment and real external-agent interoperability remain outside the completed reference implementation. Human research inspires design but does not prove identical model mechanisms or capacity constants. Provenance proves integrity, not truth or authority to act.

## License and history

[Apache License 2.0](LICENSE), copyright 2026 Eloy Kim; retain [NOTICE](NOTICE), license and attribution notices when redistributing. History: [CHANGELOG.md](CHANGELOG.md) and [CHANGELOG.zh-CN.md](CHANGELOG.zh-CN.md).
