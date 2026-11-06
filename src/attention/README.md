# Attention (L2/L3) and minimal context compiler (L4)

Import attention operations from `src/attention.ts` or `src/attention/index.ts`. L4 compilation lives in `src/context/compiler.ts`, with public types and functions exported from `src/context/index.ts`; the attention entry keeps compatible `compileContext` and context type exports. Internal absence handling uses semantic-typescript `Optional` while public optional fields remain compatible.

```ts
import { createAttention, mount, focus, compileContext } from "./attention.ts";

const now = "2026-11-06T12:00:00Z";
const scope = {
    tenantId: "tenant", principalId: "principal",
    sessionId: "session", turnId: "turn", workspaceId: "workspace",
};
let object = createAttention({
    id: "current-task",
    summary: "Read the versioned task acceptance criteria.",
    pointer: { kind: "task", id: "task-1", version: "v1" },
    scope, budget: { tokens: 1000, bytes: 4000 },
    expiresAt: "2026-11-07T12:00:00Z", reason: "Current task",
}, now);
object = mount(object, { expectedVersion: object.version, now, reason: "Needed for next request" });
object = focus(object, { expectedVersion: object.version, now, reason: "Prioritize acceptance" });
const context = compileContext([object], {
    scope, now, budget: { tokens: 2000, bytes: 8000 },
    currentVersion: pointer => pointer.id === "task-1" ? "v1" : undefined,
});
// Send context.text as model data. Keep context.exclusions/budget/usage as audit metadata.
```

The eight operations are pure: they return snapshots and do not modify arguments or domain state. Mutations require `expectedVersion`, `now` and a nonempty `reason`; a storage owner must atomically enforce the expected version when saving the result. Object `version` is a monotonically increasing presentation revision; `pointer.version` is the domain owner's version. Source pointers, Evidence/Receipt/capability/behavior references and scope are preserved independently.

- `focus(object, options, amount?)` and `blur(object, options, amount?)` adjust intensity in `[0,1]`. Blur retains summary and residency.
- `mount(object, options)` and `unmount(object, options)` change residency without changing facts.
- `persist(object, retention, options)` retains references/metadata across steps or Turns. It requires an explicit finite budget limit, reason and future expiry no later than the object's expiry. It does not mount an object or retain a body permanently.
- `update(object, patch, options)` refreshes summary, pointers, scores, expiry or staleness. It invalidates prior ranking assessment and cannot change identity or ownership scope.
- `verify(object, assessment, options)` records a version-bound posterior/evidence/recommendation. `businessVerified` is always false; L1/L6 remain responsible for business acceptance.
- `associate(root, options)` traverses a caller-supplied policy-filtered index and adjacency map with an OrderedMap queue and OrderedSet visited set. The adjacency input is a minimal `get` port from semantic-typescript's `SynchronousMapContract`; `get` returns the library's `Optional`, so `SynchronousOrderedMap` can be passed directly. Required depth, candidate, visited and edge-call limits bound traversal, including cycle edges and out-of-scope edges. Optional edge cost adds other resource charges. Results carry `authorization: "not_granted"` and never mount candidates or expand tenant/principal/Session/Workspace/Project scope.

`compileContext(objects, options)` requires a Token or byte limit and a resolver of current domain versions. It orders mounted candidates by intensity and score vector, excludes stale/expired/out-of-scope/changed or unknown versions, and checks each item's budget, active retention budget and request budget. Across-Turn inclusion additionally needs unexpired `persist(... across: "turns")`. The model payload is newline-separated JSON summaries, pointers, versions, reasons and budgets; it never retrieves source bodies or renders views. Items that do not fit are excluded whole with retrievable pointers in audit output; nothing is silently truncated. Duplicate object IDs are rejected.

`usage.bytes` measures the UTF-8 model payload, including separators. The default Token counter conservatively charges UTF-8 bytes; pass the eventual provider's exact tokenizer as `countTokens` to get provider-specific Token limits. Compilation and association report local admission usage only; the host's unified budget ledger still owns reservations/settlement and authorization must be independently checked at every resource access. Audit envelopes/exclusion records stay outside `context.text` and should be budgeted separately by the host. These in-memory operations do not promise a preemptive CPU-time limit; the milliseconds admission check stops adding work/results when a measured check exceeds the supplied limit.

Run the focused behavior tests with:

```sh
node --test src/attention/attention.test.ts
```
