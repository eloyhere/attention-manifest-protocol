# AMP: grounding in cognitive architecture

## 1. Mechanism comparison

| Architecture | Workspace | Selection | Learning | Metacognition |
|---|---|---|---|---|
| [SOAR](https://soar.eecs.umich.edu/soar_manual/02_TheSoarArchitecture/) | WM graph of identifier–attribute–value triples, all objects linked to a state/operator stack | Rules propose operators, preferences rank them, a fixed decision procedure picks one | Chunking (substate trace → variablized rule) + RL | Implicit: impasse → substate |
| [ACT-R](https://doi.org/10.1037/0033-295X.111.4.1036) | Modular buffers, one chunk each | Utility conflict resolution; retrieval by activation | Production compilation; base-level/utility learning | None built in |
| [CLARION](https://doi.org/10.1093/acprof:oso/9780199794553.001.0001) | Dual levels: implicit subsymbolic + explicit symbolic | Q-values and rule selection | Rule extraction; assimilation | Explicit Metacognitive Subsystem |
| [LIDA](https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0014803) | Global workspace; winning coalition broadcast | Attention codelets compete; coalition wins | Codelet/scheme learning | Self-system in workspace |
| [Sigma](https://doi.org/10.1515/jagi-2016-0001) | Factor graph, message passing | Inference | Gradient/structural | Weak |
| [Common Model](https://doi.org/10.1609/aimag.v38i4.2744) | WM + procedural + declarative modules | Cognitive cycle | Several | Open gap |

## 2. Shared minimal primitives

Only four are near-universal; activation and explicit metacognition are not.

- **Bounded working memory.** SOAR drops objects not linked to a state; ACT-R holds one chunk per buffer [PAPER: [Soar manual](https://soar.eecs.umich.edu/soar_manual/02_TheSoarArchitecture/); [Anderson et al. 2004](https://doi.org/10.1037/0033-295X.111.4.1036)].
- **Focus selection.** SOAR's preference-based decision procedure; LIDA's attention-codelet coalition; ACT-R's utility conflict resolution [PAPER: same].
- **Activation/decay.** ACT-R's base-level activation combines frequency and recency with power-law decay [PAPER: Anderson 2004]; SOAR has none — a real divergence.
- **Metacognitive monitor.** Explicit only in [CLARION](https://doi.org/10.1093/acprof:oso/9780199794553.001.0001)'s MCS; SOAR's impasse detector monitors failure, not self.
- **Impasse + subgoaling.** Insufficient knowledge to propose, compare or apply creates a substate [PAPER: Soar manual].
- **Chunking.** SOAR chunking and ACT-R production compilation cache a deliberation trace [PAPER: [Taatgen & Lee 2003](https://doi.org/10.1518/hfes.45.1.61.27224)].

## 3. GWT / Attention Schema: engineering value

**GWT:** a selected coalition is broadcast globally into a limited-capacity workspace, making content available to many processors [PAPER: [Madl et al. 2011](https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0014803)]. Its engineering value is arbitration: one winner, many consumers, coherent action. [VanRullen & Kanai](https://doi.org/10.1016/j.tins.2021.04.005) map this onto shared latent spaces in deep networks [PAPER]. Criticisms: no-report/overflow evidence suggests conscious content without global access; prefrontal ignition is unreliable and underpowered; and access is specified, not experience [PAPER: [SEP](https://plato.stanford.edu/entries/consciousness-neuroscience/)].

**AST:** attention is competition for limited resources; the brain models its own attention schematically, and awareness is that model's content; better models improve control, damage produces dissociations [PAPER: [Graziano & Webb 2015](https://www.frontiersin.org/journals/psychology/articles/10.3389/fpsyg.2015.00500/full)]. Value: a self-model of attention enables allocation, reporting and predicting others' attention. Criticism: deflationary — it explains the claim of awareness, not experience [PAPER: [Graziano 2019](https://grazianolab.princeton.edu/sites/g/files/toruqf3411/files/graziano_jcs_2019.pdf); SPECULATION: falsifiability].

**For AMP:** import broadcast and self-model; never consciousness. Say "global availability".

## 4. Cycle timing lessons

LIDA: 80–100 ms perception, 200–280 ms broadcast, 60–110 ms action, 260–390 ms total [PAPER: Madl et al. 2011]. ACT-R: ~50 ms per production [TEXTBOOK]. SOAR's cycle is logical (elaborate → propose → decide → apply), timed only by modelling assumptions [PAPER: Soar manual].

A cycle is a **commitment unit**, not a duration: one serial decision, buffers flushed at the boundary, bounded cycles per goal. At LLM speed, keep the invariants and drop the clock — bound cycles by event (tool result, user message) or tokens. Use two rates: fast inner loop (one tool call), slow deliberation (substate). **Define a cycle** — as one allocation decision.

## 5. Impasse taxonomy → AMP states

SOAR's manual lists tie, conflict, constraint-failure and no-change; "rejection" is the older constraint-violation label [PAPER: Soar manual; TEXTBOOK: naming varies — flagged].

| SOAR impasse | Trigger | AMP state |
|---|---|---|
| Tie | Several operators, preferences insufficient | `TIE` — underdetermined; budgeted comparison |
| No-change (state) | No operator proposed | `STUCK` — no applicable action or knowledge |
| No-change (operator) | Selected operator makes no progress | `STALLED` — repetition without state change |
| Conflict | Incompatible operators both required | `CONFLICT` — competing goals/commitments |
| Constraint-failure | Hard constraint excludes all options | `INFEASIBLE` — relax constraint or escalate |

Additions AMP needs beyond SOAR: `UNKNOWN` (missing capability/fact), `UNVERIFIED` (outcome uncheckable), `DRIFT` (goal no longer matches the Manifest) [SPECULATION]. Each carries a resolution policy and substate budget; log impasses as evidence.

## 6. Chunking / compilation and its failure modes

Chunking caches a deliberation result as a rule over the substate's dependencies [PAPER: Soar manual]. Failures:

- **Over-general chunks** — a necessary test is omitted, so the rule fires wrongly [TEXTBOOK].
- **Utility problem** — matching costs can exceed savings [PAPER: [Minton 1990](https://doi.org/10.1016/0004-3702(90)90059-9)].
- **Expensive chunks** — costly conditions; fix by restricting expressiveness [PAPER: [Tambe, Newell & Rosenbloom 1990](https://doi.org/10.1007/BF00117107)].
- **Non-contemporaneous constraints** — conditions that never co-occur; the Goal Dependency Set partly prevents them [PAPER: Soar manual].
- **Over-specialisation** — context baked in, flexibility lost [PAPER: Taatgen & Lee 2003].

The LLM analogue is weaker: prompt caching and skill libraries ([Voyager](https://arxiv.org/abs/2305.16291)) cache *artefacts*, not conditions, so preconditions go unchecked.

## 7. What breaks in the LLM mapping

- **No persistent activation.** Each call is stateless; decay must be simulated by retrieval scoring over an external store.
- **No recurrent workspace.** GWT needs re-entrant broadcast; a context window is a one-pass sequence, not a medium.
- **One shared workspace.** All buffers compete for the same tokens; mid-context content is used worst [PAPER: [Lost in the Middle](https://arxiv.org/abs/2307.03172)].
- **No production system.** No rule match, conflict resolution or utility learning; "productions" become prompts, tools or code.
- **No native impasse signal.** Stuckness must be detected externally (no state change, repetition, tool error, low confidence).
- **No free chunking.** Skill caching is engineered, with no credit assignment.

[CoALA](https://arxiv.org/abs/2309.02427) is the best bridge — memories, action space, decision cycle — but describes components, not budgets, receipts or impasse states.

## 8. Design implications for AMP

**AttentionFrame:** `frame_id`, `cycle_index`, `budget {tokens, wall_clock, tool_calls, spent}`, `attended[]` (target id, type, salience, source, TTL), `ignored[]` (target id, reason, review_at) — deliberate exclusion is the distinctive field — plus `confidence`, `open_questions`, `impasse`, `exit_criteria`.

**Manifest:** capabilities with evidence and confidence, limits, active concepts with versions and preconditions, commitments, unknowns, canonical-serialisation hash as signature, `supersedes`.

**Impasse:** typed, with a resolution policy and substate budget — never free-text "I'm stuck".

**Concepts for chunking:** canonical IDs, typed slots, pre/postconditions, provenance, version. A chunk becomes *(pattern over concept IDs → action template)* with checkable preconditions — revocable and auditable. Prose memories cannot be chunked safely.

**Do not copy:** millisecond cycles; the single-operator bottleneck; monolithic symbolic WM; activation-decay equations; full production matching; any consciousness claim; the assumption that chunking is free.

## 9. Confidence & gaps

High: SOAR impasses/chunking, LIDA timings, ACT-R modules, CoALA. Medium: CLARION and Sigma specifics (abstracts, not full texts); Common Model details (PDF blocked). Low/speculation: AMP state extensions and LLM impasse monitors — no empirical validation. Publisher PDFs were unfetchable, so page-level claims rest on abstracts and manuals; the rejection/constraint-failure naming shift is flagged [TEXTBOOK].
