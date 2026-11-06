# Workflow lifecycle (L1)

Import the public API from `src/workflow.ts` or this directory's `index.ts`.
`WorkflowStore` is an in-memory single writer for Session, Turn, Intent, Mission, Goal,
Plan, Task, Action and ActionAttempt. It never invokes an external tool. The host is
responsible for authorization, budget reservation, durable storage and independent
verification before submitting commands.

- `create(kind, input, actor)` validates parent/session references. Every entity
  begins at version 0. `get`, `list`, `getAttempt` and `history` return detached snapshots.
- `transition(kind, id, state, { expectedVersion, actor, ... })` enforces explicit
  edges and optimistic version guards. Business commits require a current
  `cancellationEpoch`. Task/Goal acceptance requires a matching contract version,
  verification reference and Evidence references; Action success alone is insufficient.
- `startAttempt` fixes operation/execution/attempt IDs and checks ancestor state,
  cancellation fences and Plan limits. A retry keeps the Action's `operationId` and
  uses a new `attemptId`. The host should call `assertExecutionAllowed` again at
  its final external commit boundary.
- `settleAttempt` records facts, including old epoch observations. A completed Turn
  leaves its executions alive; `originTurnId` and `observedInTurnId` describe different
  attribution boundaries. Late success after cancellation becomes `completed_after_cancel`.
- `requestCancel` atomically fences and marks the descendant work tree. Move work
  through `draining`, then settle children before parents. `cancelled` confirms local
  drain, not reversal of external effects. Unknown attempts block normal completion.
- `unknown_outcome -> reconciling` plus `reconcileAction` requires an explicit
  reconciliation reference before success/failure or a new attempt can be admitted.
- `invalidateGoal` keeps `state=achieved` and `achievedAt` history while setting
  `validity=invalidated`. `attachCorrectivePlan` and `revalidateGoal` record correction.
  Consumers must check Goal validity rather than its historical state alone.
- Task dependencies must already exist in the same draft Plan, yielding a DAG by
  construction; the ready gate validates it again. Plan bounds include max attempts,
  deadline, progress metric and dead-letter owner. This kernel performs no retries.
- A clarifying Turn carries `continuationKey`; resume requires matching
  `{ clarification: { replyTo, continuationKey } }`. New inputs retain their explicit
  `steering | status | cancel | new_intent` classification.

The store uses semantic-typescript `SynchronousUnorderedMap` for entities/attempts,
`SynchronousOrderedMap` for events, and `SynchronousOrderedCollectable` for projections.
`snapshot()` returns a detached, JSON-compatible `WorkflowSnapshot`.
`WorkflowStore.restore(snapshot, clock?)` validates schema, references, states, CAS versions,
cancellation epochs, Task DAGs, attempts and the event version chain before returning a new
store. Restoration reads no clock and invokes no command or external effect. The host owns
snapshot storage, reconciliation of pending effects, fresh authorization and budget checks.

Intent/Mission references describe the logical business chain. Their cancellation/lifecycle
parent is Session: cancelling a Mission affects its Goals through Actions, and preserves the
accepted Intent and origin Turn as historical capture facts. An accepted Intent has no further
local transitions and does not prevent Session closure. A settled failed Action may be retried
while its parents remain executable; optional failed Actions do not block independently
verified Task acceptance or Session closure. Running/unknown attempts always block closure.

Each domain exports its own typed command service from `src/<domain>/index.ts`:
`SessionService`, `TurnService`, `IntentService`, `MissionService`, `GoalService`,
`PlanService`, `TaskService` and `ActionService`. Bind all services to the same store.
Services keep no state/cache and delegate every version, cancellation, acceptance and
execution check to that single writer. The common `create/find/get/list/transition` port
remains available alongside named domain commands. `find` returns semantic-typescript
`Optional<Entity>`; `ActionService.findAttempt` and `WorkflowStore.findAttempt` return
`Optional<ActionAttempt>`. Missing-query callers can compose `map/flatMap/filter/orElse`
without inventing a Maybe wrapper; throwing command lookups keep the existing `get` API. Cancellation services expose
`requestCancel/drain/finishCancellation`; Goal adds invalidation/correction/revalidation,
Plan exposes detached Tasks/bounds and validates the DAG at `ready`, and Action exposes
attempt admission/settlement/reconciliation. Runtime imports flow from domain services
to the workflow service base; cross-domain entity references are type-only.

```ts
import { WorkflowStore } from "../workflow/index.ts";
import { GoalService } from "../goal/index.ts";
import { PlanService } from "../plan/index.ts";
const store = new WorkflowStore();
const goals = new GoalService(store);
const plans = new PlanService(store);
// goals and plans read and command the same authoritative state.
```

Run the exported `runWorkflowSelfTest()` for a concise result, or with Node >=24:

```sh
node --test src/workflow/workflow.test.ts
node --input-type=module -e "import('./src/workflow.ts').then(m => console.log(m.runWorkflowSelfTest()))"
```
