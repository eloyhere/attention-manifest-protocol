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
| Agent surface | `agent`, `model`, `runtime`, `workflow` | Agent-visible tool registry, dispatch gateway, weighted discovery tree, model port, single-writer lifecycle |
| Persistence | `entity`, `cache`, `service`, `repository`, `sql`, `connection` | JPA-style metadata, LRU caches, persistence context, generic repositories, SQLite and connection pooling |

The agent never receives a mutable store. It receives projections, versions and an explicit list of actions it is allowed to attempt.

## Quick start

```sh
npm ci
npm run check:architecture     # strict typecheck, no unused symbols
npm run test:architecture      # 460+ tests
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

The bootstrap tool `attention_manifest_protocol_discover` is the one naming exception (`<prefix>_discover`); it sits outside this table. See [Discovery](#discovery).

`AgentGateway` dispatches the surface and enforces the mechanics:

1. the binding (`tenantId`, `principalId`, `sessionId`, `policyVersion`, `cancellationEpoch`) is host-supplied and validated;
2. the tool must exist and be exposed by the configured surface;
3. model parameters may not carry host context (`tenantId`, `sessionId`, `policyVersion`, `owner`, `fence`, …) at any depth;
4. mutating verbs require an idempotency key;
5. a host `authorize` hook sees the declared authorities;
6. one journal record is written per call.

Failures are typed: `binding_invalid`, `unknown_tool`, `not_exposed`, `invalid_parameters`, `unauthorized`, `mutating_requires_idempotency_key`, `handler_missing`, `handler_failed`. The gateway does not implement policy, budget or leases; it only refuses to dispatch without them.

### Discovery

`attention_manifest_protocol_discover` is a bootstrap entry, not a domain verb. Configure `AgentGateway` with `discovery`, and `gateway.tools` contains only this tool; `gateway.catalog` still exposes the configured surface so the host can select and load contracts after a discovery call. The full surface remains dispatchable once loaded.

```ts
import {
    AgentGateway, DISCOVER_TOOL_NAME, createConversationDiscoveryProvider, createHostModuleDiscoveryProvider,
    createNetworkDiscoveryProvider, createSessionFileDiscoveryProvider, createSessionOutlineDiscoveryProvider,
} from "attention-manifest-protocol/agent";

const gateway = new AgentGateway({
    handlers,
    authorize: (authority, binding) => policy.allows(authority, binding),
    discovery: { providers: [
        createHostModuleDiscoveryProvider(readHostRegistry),
        createSessionFileDiscoveryProvider(readSessionFiles),
        createSessionOutlineDiscoveryProvider(readSessionOutlines),
        createConversationDiscoveryProvider(readConversation),
        createNetworkDiscoveryProvider(searchWeb),
    ] },
});
const tree = await gateway.call(DISCOVER_TOOL_NAME, {
    query: "edit the failing test",
    sources: ["amp", "session_files", "session_outlines"],
}, { binding });
```

`query` is required. `sources` accepts `host_modules`, `amp`, `session_files`, `session_outlines`, `conversation` and `network`; it defaults to the first five, so the network is queried only when asked. `limit` (6, max 50), `maxPerModule` (3), `minimumScore` (0.1) and `weights` (`lexical` 0.45, `semantic` 0.3, `signature` 0.1, `context` 0.15) bound the result. AMP descriptors carry stable action synonyms; `discovery.keywords` adds local vocabulary and `discovery.signals` supplies semantic, signature and context scores.

Elasticsearch is supported through the existing `@elastic/elasticsearch` dependency. Construct a `Client` in the host — `new Client({ node: process.env.ELASTICSEARCH_URL })` — and register `createElasticsearchDiscoveryProvider({ client, index, source })` as one provider. The index must contain documents shaped like `ElasticsearchDiscoveryDocument` (`id`, `source`, `kind`, `module`, `name`, `summary`, `target`, optional `keywords`, `searchText`, scope fields `tenantId`/`principalId`/`sessionId`, optional 0–1 `semantic`/`signature`/`context`). Map `source`/`kind`/`module` and the scope fields as `keyword`, `name`/`summary`/`searchText` as `text`, `target` as `object` or `flattened`, and the signals as `float`. One provider owns one source; tenant and session filters are added to every query, and `scoreSignal` can fold the BM25 `_score` into one normalized signal. The host owns indexing, mapping and the write path; a missing index makes that source unavailable.

The result is a tree `query → source → group → item`. Each item carries `score`, `scores`, effective `weights`, `matchedTerms` and a navigation-only `target` (tool name, file id/path/version/line, outline node, message/turn or URL). `unavailableSources` distinguishes "not searched" from "no match"; `authorization` is always `not_granted`.

Providers are generic host ports, not plugin bindings. A provider receives the binding and returns only records that binding may see; session records are additionally checked against `tenantId`/`principalId`/`sessionId` before ranking. A provider failure marks its source unavailable without discarding other sources. The core never walks a filesystem or performs a network request: `createNetworkDiscoveryProvider` calls the host's search function, and AMP tools require an existing handler plus their own authority. `discovery:<source>` authorities are checked per request; `execution:find` gates the entry itself.

## Execution, evidence and governance

- `execution` runs typed child calls through the executor; `policy` provides the PEP and `budget` the ledger. A successful tool call is not acceptance.
- `receipt` and `provenance` record what actually happened; `verification` checks business semantics independently of the executor.
- `workflow` is a single-writer lifecycle with version guards and cancellation epochs; it is intentionally absent from the agent surface.
- `capability`, `manifest`, `profession`, `behaviour` and `governance` narrow or release authority. They are host actions.

## Persistence

Five layers carry an aggregate from declaration to disk: **entity → cache → service → repository → sql**.

| Layer | Module | Responsibility |
| --- | --- | --- |
| Entity | `src/entity` | JPA-style metadata: `Entity`, `Key`, `Column`, `Index`, `UniqueConstraint`, `Association` and the `OneToOne<T>`/`OneToMany<T>`/`ManyToOne<T>`/`ManyToMany<T>` wrappers; no `Metadata` suffix |
| Cache | `src/cache` | An independent cache layer: a TTL LRU built on `semantic-typescript`'s `SynchronousOrderedLRUMap`, plus a `Proxy` that caches service reads and invalidates a namespace after writes |
| Service | `src/service` | `Store`, the JPA-style persistence context: process-wide identity map, lazy loading proxies, write-through mutations, `new`/`managed`/`detached`/`removed` states and nested transactions |
| Repository | `src/repository` | Generic `Repository<T>` (`get`/`put`/`delete`/`list`/`count`), optimistic CAS through `expectedVersion`, and an append-only event log via `appendEvent`/`readEvents` |
| SQL | `src/sql`, `src/connection` | `node:sqlite` driver with WAL, foreign keys and versioned migrations; a synchronous connection pool with transactions and savepoints |

The chain is declarative rather than a strict call stack: `Store` composes one repository per entity kind; each repository reads through the entity cache and writes to SQLite; a service `Proxy` is how a caller opts into caching that service's reads.

### Cache

The cache layer is independent of the store. `createEntityCache({ maxEntries, ttlMilliseconds })` returns a TTL LRU (`SynchronousOrderedLRUMap` from `semantic-typescript`) with `get`/`set`/`invalidate`/`clear`/`stats`. `createServiceProxy(service, cache, { namespace })` wraps any service in a `Proxy`: inferred `get`/`find`/`list`/`read`/… methods are cached by method and stable argument tuple, and successful `set`/`save`/`update`/`delete`/… writes invalidate only that namespace. `ServiceRegistry`/`registerService` bind one namespace to a service name. `createCachingProxy`/`createCacheProxyHandle` provide a self-contained variant with its own LRU and `all`/`byArgs` invalidation. Failed reads are not retained; a hit returns the same reference, or the same Promise for an asynchronous read.

### Store and identity

By default, `Store.open()` writes to the hidden, git-ignored directory `.attention-manifest-protocol/` under the current working directory and creates `store.sqlite` inside it. `path` may name a directory, an explicit `.sqlite` file or `:memory:`.

```ts
import { Store } from "attention-manifest-protocol/service";

const store = Store.open();                                  // .attention-manifest-protocol/store.sqlite
const projectStore = Store.open({ path: "var/state" });      // var/state/store.sqlite
const scratch = Store.open({ path: ":memory:" });

const goal = store.save("goal", { id: "g1", title: "Ship" });
goal.title = "Ship v1";                                      // write-through: version bump and CAS
store.load("goal", "g1");                                    // lazy proxy; no query until a property is read
store.resolve("goal", "g1");                                 // eager existence check
store.state("goal", "g1");                                   // "managed"
store.detach("goal", "g1");                                  // this proxy now keeps writes local
store.transaction((tx) => {
    tx.save("goal", { id: "g2", title: "Second" });
    tx.save("task", { id: "t1", goalId: "g2" });
});
```

A managed proxy is globally unique per `(database path, kind, id)`: opening the same file twice yields the same identity, and a cache hit inside the repository returns the same object reference. `load` is lazy, `resolve` checks existence eagerly, and `refresh` replaces the managed snapshot. `detach` marks the identity `detached`: the old proxy keeps its local snapshot and later mutations never reach SQLite, while a new `load`/`resolve` creates a fresh managed proxy. `remove` marks it `removed` and the old proxy fails with `not_found`.

`Store.transaction(work)` is synchronous: a nested call becomes a savepoint, a thrown error rolls back rows, cache entries and the loaded state of proxies written in the transaction together, and a Promise return is rejected. Writes are immediate rather than deferred to a commit.

### Connection, transactions and savepoints

The lower-level API is exported separately:

```ts
import { createConnectionPool } from "attention-manifest-protocol/connection";
import { openSqlite } from "attention-manifest-protocol/sql";

const path = ".attention-manifest-protocol/store.sqlite";    // created by Store.open()
const pool = createConnectionPool({
    maxConnections: 4,
    open: () => openSqlite({ path }),
});

const connection = pool.acquire();
try {
    const transaction = connection.startTransaction();
    try {
        const savePoint = transaction.savePoint("before_cleanup");
        transaction.run({ sql: "DELETE FROM events WHERE kind = ?", parameters: ["scratch"] });
        savePoint.rollback();                                // undo only this block
        transaction.commit();                                // requires no active savepoints
    } finally {
        if (transaction.state === "active") transaction.rollback();
    }
} finally {
    connection.release();                                    // release also rolls back an active transaction
}
pool.close();
```

The pool is synchronous: `acquire()` either returns an idle connection or throws `ConnectionPoolError` with code `pool_exhausted`; `withConnection`/`withTransaction` scope the lease automatically. Transactions run `BEGIN IMMEDIATE`, savepoints are strictly LIFO, and `commit()` fails while a savepoint is active. `openSqlite` uses `node:sqlite`, switches file databases to WAL (except read-only connections), enables foreign keys and a five-second busy timeout by default. `migrate()` applies versioned `CORE_MIGRATIONS` in their own transactions and is idempotent; `schemaVersion()` reports the current version.

### JPA metadata

The metadata types are `Entity<T>`, `Key`, `Column`, `Index`, `UniqueConstraint` and `Association`; the builders are `entity`, `id`/`generatedId`/`compositeId`, `column`, `index`, `uniqueConstraint` and the association constructors. There is no `Metadata` suffix.

```ts
import { entity, id, column, index, uniqueConstraint, manyToMany } from "attention-manifest-protocol/entity";
import type { Entity, ManyToMany } from "attention-manifest-protocol/entity";

interface Goal {
    readonly id: string;
    readonly version: number;
    readonly updatedAt: string;
    readonly payload: { readonly title: string };
    readonly dependencies: ManyToMany<Goal>;                 // association declaration; not a column
}

const goalEntity: Entity<Goal> = entity<Goal>({
    kind: "goal",
    table: "entities",
    key: id(),
    columns: [
        column("id", { nullable: false }),
        column("tenantId"),
        column("sessionId"),
        column("version", { nullable: false, version: true }),
        column("updatedAt", { nullable: false }),
        column("payload", { nullable: false }),
    ],
    indexes: [index("goals_tenant_session", ["tenant_id", "session_id"])],
    uniqueConstraints: [uniqueConstraint("goals_tenant_id", ["tenant_id", "id"])],
    associations: [
        manyToMany("dependencies", "goal", {
            joinTable: "goal_dependencies",
            joinColumns: ["goal_id"],
            inverseJoinColumns: ["dependency_id"],
            cascade: ["persist"],
            fetch: "lazy",
        }),
    ],
});
```

`entity()` builds and validates metadata (key/column alignment, unique column and index names, association ownership and the single `@Version` column); it does not register it. Every built-in `EntityKind` is registered in `ENTITY_REGISTRY`, and `Store` resolves kinds through that registry; all aggregates share the `entities` table and store each aggregate as a JSON payload. For the built-in registry, `index` and `uniqueConstraint` declarations are applied as SQLite indexes on open (`Store.indexReport` lists what was applied or skipped).

### Persistence boundaries

- **Cascades are declared, not executed.** `cascade: ["persist"]` is metadata; `Store.cascadePlan` exposes the associations declared for a kind, and the reserved `CascadePolicy` shape keeps `implemented: false`. No persist/merge/remove/refresh/detach cascade runs.
- **Detached writes stay local.** After `detach`, mutations update only the proxy's snapshot and are never written through.
- **A cache hit returns the same reference.** The repository cache is reference-preserving; it does not clone on read.
- **One identity per `(database path, kind, id)`.** Exactly one managed proxy exists for that tuple in the process; `detach` retires it and later loads create a new one. Each `:memory:` store gets a private identity namespace.
- **Transactions are synchronous and SQLite has one writer.** `Store` holds one pooled connection; `Store.transaction` rejects Promise work; the pool is synchronous; and write transactions use `BEGIN IMMEDIATE`. WAL lets other readers proceed, but there is no asynchronous connection acquisition or multi-writer parallelism.

## Testing

The suite is executable documentation: **460+ tests** across domains, plus a dedicated end-to-end scenario that runs against a real temporary directory. The persistence layer contributes 81 focused tests.

| Area | Covered |
| --- | --- |
| Files | Outline lookup, plan/replace, idempotent flush, stale detection, lease fencing, BOM/CRLF fidelity, code-point byte boundaries, durability |
| Documents | DOCX/XLSX/PPTX, legacy DOC/XLS/PPT, PSD/PSB layer trees, DXF/DWG containers, 3DS, CFB containers, archives |
| Failure paths | Corrupted archives, unsupported formats, path traversal, size ceilings, budget truncation |
| Project | Environment seeds, gaps, CAS, kind application and overrides |
| Persistence | JPA metadata validation, LRU/TTL cache, proxy invalidation, pool exhaustion, LIFO savepoints, CAS, identity map, detach semantics, migrations |
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
| [src/entity](src/entity/) | JPA-style metadata: keys, columns, indexes, associations and the entity registry |
| [src/cache](src/cache/) | LRU entity cache and cached service proxies |
| [src/service](src/service/) | `Store` persistence context |
| [src/repository](src/repository/) | Generic repositories, CAS and events |
| [src/sql](src/sql/) | `node:sqlite` driver and migrations |
| [src/connection](src/connection/) | Synchronous connection pool, transactions and savepoints |
| [src/project](src/project/) | Rules, metadata, views, outline, kinds, environments, series |
| [src/agent](src/agent/) | Agent surface registry, dispatch gateway, weighted discovery tree and generic discovery providers |
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
