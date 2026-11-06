# Attention Manifest Protocol (AMP)

**English** · [简体中文](README.zh-CN.md) · [Changelog](CHANGELOG.md)

AMP is a metacognitive protocol for agents. It gives an agent a vocabulary for declaring what it knows and owes, a finite attention budget, a place to record evidence and costs, and a narrow, host-controlled surface through which it may act. This repository is the reference implementation: TypeScript ESM, **Node.js 24 or later**, Apache-2.0, version `0.6.1` (unreleased work is tracked in the [changelog](CHANGELOG.md)).

The model proposes; the host authorises. Every durable effect is versioned, hash-checked and, where it matters, independently verifiable. Nothing in this library grants authority merely because a function exists.

## Design principles

- **Declare before acting.** Knowledge, obligations, budgets and exclusions are explicit objects, not implied state.
- **The host owns authority.** Policies, budgets, leases, capability registration and behaviour release are host decisions; the model can request, never grant.
- **Projections are read-only.** Outlines, contexts and discovery results are previews. They do not compile, execute or prove truth.
- **Ports, not globals.** Storage, time, locking and model access are injected ports, so the runtime can be embedded without a database.

## Architecture

The root entry exposes one namespace per domain. Modules are independent; the important wires are ports passed by the host.

| Group | Modules | Responsibility |
| --- | --- | --- |
| Interaction | `session`, `turn`, `intent`, `mission`, `goal`, `plan`, `task` | Identity, turn taking, captured intent, goals and criteria, plans and tasks |
| Execution | `action`, `execution`, `tool`, `tooling`, `manifest`, `policy`, `budget`, `capability` | Attempts, tool contracts, policy enforcement, budget ledger, capability registry |
| Attention | `attention`, `context`, `reactive` | Attention objects, focus/persistence, context compilation, proxy-backed lazy views |
| Evidence | `evidence`, `provenance`, `receipt`, `verification`, `retrieval` | Claims and citations, provenance chains, execution receipts, independent verification, candidate retrieval |
| Workspace | `workspace`, `file` | Scoped files, outlines, editing primitives, storage adapters, document and archive readers |
| Project | `project` | Rules, metadata, views, project outline, project kinds, environments and toolchain series |
| Cooperation | `cooperation`, `profession`, `behavior`, `governance` | Delegation, authority narrowing, behaviour release, governance workflows |
| Agent surface | `agent`, `model`, `runtime`, `workflow` | Agent-visible tool registry, dispatch gateway, model port, single-writer lifecycle |
| Persistence | `repository`, `entity`, `service`, `sql` | Ports and adapters for durable state |

The agent never receives a mutable store. It receives projections, versions and an explicit list of actions it is allowed to attempt.

## Quick start

```sh
npm ci
npm run check:architecture     # strict typecheck, no unused symbols
npm run test:architecture      # 460 tests
npm run scenario               # the end-to-end scenario suite on its own
npm run build                  # browser demo bundle in dist/
npm run build:lib              # publishable ESM library in lib/
npm run demo:architecture      # small executable walkthrough
```

## Library usage

```ts
import { Workspace } from "attention-manifest-protocol/workspace";
import { NodeFileStorage, createOutlineProvider } from "attention-manifest-protocol/file";
import { Project, createProjectFromKind, kinds } from "attention-manifest-protocol/project";
import { AgentGateway } from "attention-manifest-protocol/agent";
```

| Specifier | Resolves to |
| --- | --- |
| `attention-manifest-protocol` | `lib/index.js`, every domain as a namespace |
| `attention-manifest-protocol/<domain>` | `lib/<domain>/index.js` |
| `attention-manifest-protocol/<domain>/<file>.js` | one compiled module |

`npm run build:lib` rebuilds `lib/`; `prepublishOnly` runs it before publishing. The Vite demo (`src/main.ts`) is not part of the library build.

## Workspace and files

`Workspace` binds a tenant, a root and a storage port; a `File` is a mounted, versioned view of one path.

```ts
const workspace = new Workspace({
    tenantId: "tenant-a",
    rootId: "root-1",
    storage: new NodeFileStorage({ root }),
    outline: createOutlineProvider(),
});

const file = workspace.mount("src/index.ts", { mode: "writable", owner: "agent" });
file.outline();                                        // symbols with ranges
file.replace({ mode: "string", text: "return a - b;" }, "return a + b;");
file.flush({ idempotencyKey: "fix-add-1" });            // CAS commit
```

Mounting activates the file and, for writable mounts, acquires a lease. `flush()` is a compare-and-swap: the base hash, the lease fence and the file lock must all still match, otherwise the call fails with `version_conflict`, `stale` or `fence_rejected` and nothing is written.

### Write and replace modes

`write(content, target?)` — omit the target to replace the whole buffer.

| Target | Meaning |
| --- | --- |
| `{ mode: "line", start, end }` | 0-based lines, `end` exclusive; surrounding line structure and line endings are preserved |
| `{ mode: "byte", start, end }` | UTF-8 byte offsets, `end` exclusive; the range must fall on code-point boundaries |
| `{ mode: "outline", id }` | The full range of one outline node; a heading covers its whole section |

`replace(target, replacement, options?)` accepts `string` (literal, no `$` expansion), `regex` (stateless flags only; `$$`, `$&`, `` $` ``, `$'`, `$1`–`$99`, `$<name>`), and the three structural targets above. Literal and regex matches are unique by default; ambiguity fails with `ambiguous_match` instead of picking one.

Both paths accept `expectedBaseHash` and `expectedBufferVersion`, and `planWrite`/`planReplace`/`locate`/`diff` expose the edit before it is committed. A dirty buffer is never flushed implicitly.

### Ranges and outlines

Every outline node carries a `range`: `startLine`/`endLine` are 0-based (end exclusive) and `startByte`/`endByte` are UTF-8 offsets (end exclusive). A `dirty` flag marks nodes whose buffer has not been committed. Ranges are validated against the buffer, so a stale range cannot silently address different bytes.

### Binary documents

A mount that cannot be decoded as text is mounted as opaque bytes: `snapshot().binary` is `true`, `readBytes()` exposes the buffer (optionally a byte range), `writeBytes()` replaces it and `flush()` commits it through `compareAndSwapBytes`. Text APIs (`read`, `write`, `replace`, `readLines`, `outline`, `diff`) fail with `invalid_target` rather than corrupting a binary file. `documentOutline()` works on the byte buffer, including uncommitted edits.

Writing proprietary formats is deliberately **not** implemented here: `writeBytes` commits opaque bytes only. Creating or editing Office, PSD, CAD or archive files belongs to a host plugin.

### Storage and locking

`NodeFileStorage` confines paths to a real root, rejects `..`, absolute paths, backslashes, NUL and symlink escapes, enforces a size ceiling, and commits with a temporary file, `fsync`, atomic rename and directory `fsync`. `InMemoryFileStorage` provides the same contract for tests. The on-disk lock is advisory: it protects cooperating processes through a monotonic fence, and a process that ignores the protocol can still race — which surfaces as a hash conflict, never as silent loss.

## Document and archive outlines

Outlines are structural previews. They do not decode pixels, meshes, formulas, macros or external relationships, and they never modify the source.

**32 built-in languages:** Markdown, plain text, TeX, JavaScript, TypeScript, C, C++, Java, C#, Python, Go, Swift, XML, JSON, MySQL, Oracle SQL, SQL Server, HTML, Vue, CSS, SCSS, Sass, and compressed archives (text outlines); Word, Excel, PowerPoint, Access, Publisher, Photoshop, CAD, 3ds Max and SolidWorks (binary formats, through `documentParser`).

| Format | Projection |
| --- | --- |
| DOCX / `.doc` | Headings, paragraphs and tables; legacy files go through the FIB and Clx/PlcPcd piece table |
| XLSX / `.xls` | Sheets and cells; legacy BIFF8 uses `BOUNDSHEET`, `SST` (including `CONTINUE`), `RK`, `MULRK` and cached formula values |
| PPTX / `.ppt` | Slides and their text; legacy files are walked as MS-PPT records |
| PSD v1 / PSB v2 | Full layer tree with groups (`lsct`/`lsdk`), `luni` names, bounds, blend and opacity |
| DXF | Layers, blocks and entity-type counts |
| DWG R13/R14/R2000 | Section table (number, offset, size); the entity graph is not decoded |
| 3DS | Named object chunks |
| `.max`, SolidWorks | Complete CFB container: directory tree, stream sizes and CLSIDs, summary-information properties |
| ZIP / TAR / TAR.GZ / GZ | Archive listing (central directory, tar headers, gzip members); members are never extracted |

Explicitly unsupported, with a precise error rather than an empty outline: DWG R2004+ (per-section LZ77 compression plus Reed–Solomon encryption), DWG R10–R12, Access `.mdb/.accdb`, Publisher `.pub`, 7z, RAR, XZ, bzip2, zstd, encrypted Word/BIFF documents, PSB-sized unknowns, and the proprietary semantics inside `.max` and SolidWorks streams (scene graph, feature tree, configurations). Those formats need a dedicated decoder or a host adapter; the container metadata above is not a substitute.

## Project model

`Project` holds versioned project knowledge: rules, metadata (path, tags, rule ids) and derived views. It also owns an **environment**:

```ts
const project = createProjectFromKind(
    kinds.createDefaultProjectKindRegistry().requireKind("go"),
    { tenantId: "tenant-a", rootId: "root-1" },
);
project.environment;                    // variables, paths, dependencies (frozen)
project.configureEnvironment(
    { dependencies: [{ id: "go", scope: "build", version: ">=1.22" }] },
    { expectedVersion: 0 },             // CAS
);
project.environmentPlan();              // gaps: unset variables, missing paths, unpinned dependencies
project.describeEnvironment();          // Markdown brief with numbered next steps
```

- `variables` are defaults; an empty string means "declared but unset" and becomes a gap.
- `paths` are canonical workspace-relative POSIX paths; `dependencies` carry `id`, optional `version`/`manager`, `scope` and `optional`.
- `planEnvironment` compares declared paths with project metadata and reports what an agent must still configure; `describeEnvironment` renders that brief. This is guidance, not a write grant: configuration is applied by the host or a plugin.
- `project.kinds` registers seven kinds (`go`, `tex`, `text`, `photoshop`, `cad`, `max3d`, `solidworks`) with markers and default environments, detects them from a file list, and supports atomic batch registration and permanent id retirement.
- `project.serie` registers toolchain series (`npm`, `pnpm`, `node`, `maven`, `gradle`, `make`, `android`, `ios`) with declarative steps; nothing is executed.
- `project.outline` is a rooted forest for the project tree, with the same `range`/`dirty` contract as file outlines.

## Agent surface

`src/agent/surface.ts` is a declarative three-tier registry. Tool names are `attention_manifest_protocol_<module>.<verb>`.

| Tier | Modules | Exposure |
| --- | --- | --- |
| `agent` | `session`, `turn`, `intent`, `mission`, `goal`, `plan`, `task`, `action`, `attention`, `project`, `workspace`, `cooperation`, `evidence`, `execution`, `budget` | Offered to the model; `budget` exposes `remaining` only |
| `host` | `capability`, `manifest`, `provenance`, `receipt`, `verification`, `retrieval`, `model`, `runtime` | Host only; never listed as tools |
| `hidden` | `workflow`, `policy`, `profession`, `behaviour` | Never exposed; `assertAgentAccessible` rejects them |

`AgentGateway` dispatches the surface and enforces the mechanics:

1. the binding (`tenantId`, `principalId`, `sessionId`, `policyVersion`, `cancellationEpoch`) is host-supplied and validated;
2. the tool must exist and be exposed by the configured surface;
3. model parameters may not carry host context (`tenantId`, `sessionId`, `policyVersion`, `owner`, `fence`, …) at any depth;
4. mutating verbs require an idempotency key;
5. a host `authorize` hook sees the declared authorities;
6. one journal record is written per call.

Failures are typed: `binding_invalid`, `unknown_tool`, `not_exposed`, `invalid_parameters`, `unauthorized`, `mutating_requires_idempotency_key`, `handler_missing`, `handler_failed`. The gateway does not implement policy, budget or leases; it only refuses to dispatch without them.

## Execution, evidence and governance

- `execution` runs typed child calls through the executor; `policy` provides the PEP and `budget` the ledger. A successful tool call is not acceptance.
- `receipt` and `provenance` record what actually happened; `verification` checks business semantics independently of the executor.
- `workflow` is a single-writer lifecycle with version guards and cancellation epochs; it is intentionally absent from the agent surface.
- `capability`, `manifest`, `profession`, `behaviour` and `governance` narrow or release authority. They are host actions.

## Testing

The suite is executable documentation: **460 tests** across domains, plus a dedicated end-to-end scenario that runs against a real temporary directory.

| Area | Covered |
| --- | --- |
| Files | Outline lookup, plan/replace, idempotent flush, stale detection, lease fencing, BOM/CRLF fidelity, code-point byte boundaries, durability |
| Documents | DOCX/XLSX/PPTX, legacy DOC/XLS/PPT, PSD/PSB layer trees, DXF/DWG containers, 3DS, CFB containers, archives |
| Failure paths | Corrupted archives, unsupported formats, path traversal, size ceilings, budget truncation |
| Project | Environment seeds, gaps, CAS, kind application and overrides |
| Agent | Surface tiers, gateway authorization, hidden-tool masking, parameter injection, journaling |

```sh
npm run scenario                          # 14 end-to-end scenarios
node --test src/file/document/archive.test.ts
```

## Repository layout

| Path | Contents |
| --- | --- |
| [src](src/) | Domain modules exported by `src/index.ts` |
| [src/file](src/file/) | Ranges, charset, edits, outlines, languages, documents, archives, storage adapters |
| [src/workspace](src/workspace/) | Mounting and file lifecycle |
| [src/project](src/project/) | Rules, metadata, views, outline, kinds, environments, series |
| [src/agent](src/agent/) | Agent surface registry and dispatch gateway |
| [src/scenario](src/scenario/) | End-to-end scenario suite |
| [tools](tools/) | Test discovery, demo and declaration rewriting |
| [document](document/) | Implementation notes (Chinese) |

## Boundaries

- Outlines are source-version-bound previews; they are not compilers, language servers or type checkers. Missing nodes mean "not recognised", not "invalid source".
- Document readers are read-only and structural. They do not decode pixels, meshes, formulas, macros or external links, and they never write the source file.
- Unsupported formats fail with `unsupported_format` and a reason; they never return an empty outline that looks like success.
- Provenance proves integrity, not truth or authority to act. Sandbox isolation, multi-tenancy and production hardening remain host responsibilities.

## Licence and history

[Apache License 2.0](LICENSE), copyright 2026 Eloy Kim; retain [NOTICE](NOTICE), the licence and attribution notices when redistributing. History: [CHANGELOG.md](CHANGELOG.md) and [CHANGELOG.zh-CN.md](CHANGELOG.zh-CN.md).
