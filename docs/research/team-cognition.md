# Team cognition and coordination failure: grounding brief for AMP

## 1. Shared mental models: evidence

Team knowledge has four content domains — **task**, **team**, **equipment**, **situation** — and two measurable properties: **similarity** and **accuracy** [PAPER, Cannon-Bowers & Salas; ⚠ no open URL]. Best synthesis: 231 correlations from 65 studies: team cognition strongly predicts behavioral process, motivation and performance, explaining **incremental variance after dynamics are controlled** [PAPER](https://doi.org/10.1037/a0017328). A measurement meta-analysis (23 studies): **only content/structure operationalizations predicted process** — measurement changes conclusions [PAPER](https://doi.org/10.1037/a0017455). Similarity and accuracy independently predict process and performance [PAPER](https://doi.org/10.1037/0021-9010.85.2.273).

Mature position: **compatible, not identical** — overlap where interdependence is high, distribute elsewhere; full overlap is costly. ⚠ Indirectly supported.

## 2. Transactive memory and failure modes

Wegner's TMS: a **directory** (who knows what), **directory updating**, **retrieval coordination**. Measured on specialization, credibility, coordination — 15-item field scale [PAPER](https://doi.org/10.1037/0021-9010.88.4.587).

TMS-trained groups (not merely communicating ones) performed better on radio assembly, mediated by TMS not communication [PAPER](https://doi.org/10.1006/obhd.2000.2891); field teams with stronger TMS perform better [PAPER](https://doi.org/10.1037/0021-9010.88.4.587); review [PAPER](https://doi.org/10.1080/19416520.2011.590300). Failures: **directory staleness** (membership change degrades collective knowledge, TMS implicated [PAPER](https://doi.org/10.1016/j.obhdp.2007.01.005)); **misattribution** (routing to a stale holder); **credibility decay**; retrieval-coordination breakdown.

## 3. Joint commitment and its lifecycle

**Bratman** [PAPER](https://doi.org/10.2307/2185537): shared intention = mutual responsiveness + commitment to the joint activity + commitment to mutual support. Obligations are internal to the plan, defeasible, mutually cancellable — no supra-individual entity. **Gilbert** [BOOK](https://academic.oup.com/book/9917): joint commitment is not reducible to individual commitments, **cannot be rescinded unilaterally**, and yields entitlements (to rebuke) plus obligations (to perform or concur in release).

Computational formalizations are partial: joint goals as mutual-belief fixpoints with "until" termination [PAPER](https://doi.org/10.2307/2216075); collaborative plans separating "intending that" from "intending to" [PAPER](https://doi.org/10.1016/0004-3702(95)00103-4). ⚠ No machine-checkable Gilbert-style semantics exists.

Lifecycle: propose → **mutual accept** → execute and monitor → discharge | **mutual cancel** | breach → notify and repair.

## 4. Grounding across more than two parties

Grounding criterion: mutual belief that understanding suffices *for the current purpose*; partners minimize **joint** cost (*least collaborative effort*) [PAPER, Clark & Brennan 1991; ⚠ no URL]. Tangram dyads converge from long descriptions to short labels, and repair *refashions* rather than restarts [PAPER](https://doi.org/10.1016/0010-0277(86)90010-7).

Beyond dyads, communal common ground is assumed rather than checked, acknowledgment is ambiguous, and per-assertion cost rises — so teams shift to **broadcast + template + spot-check**. Team common ground must be shared *and integrated*; breakdowns concentrate in unstated assumptions [PAPER, Klein 2004; ⚠ no URL].

## 5. High-stakes protocols with measured effects

- **CRM**: 58 evaluations: positive reactions, learning, behavior change — but **no demonstrable safety/bottom-line effect** [PAPER](https://doi.org/10.1518/001872001775870386).
- **Surgical checklist**: 8 cities, 3,733/3,955 patients; deaths 1.5%→0.8% (P=0.003), complications 11.0%→7.0% (P<0.001) [PAPER](https://doi.org/10.1056/NEJMsa0810119). ⚠ Pre-post; mandatory province-wide rollout found no reduction (Urbach 2014) — implementation moderates.
- **I-PASS handoff**: 9 hospitals, 10,740 admissions; errors −23%, preventable adverse events −30%, no added handoff time [PAPER](https://doi.org/10.1056/NEJMsa1405556).
- **Debriefs**: 46 samples, N=2,136, d≈0.67 (~25% over control) [PAPER](https://doi.org/10.1177/0018720812448394).
- **ICS**: bureaucratic form yielding flexible, reliable organizing via roles, scalable spans of control, pre-specified command transfer [PAPER](https://doi.org/10.2307/3069401); doctrine [STANDARD](https://www.fema.gov/emergency-managers/nims).
- **TeamSTEPPS**: briefs/huddles/debriefs, SBAR, call-outs, check-backs, two-challenge rule [STANDARD](https://www.ahrq.gov/teamstepps/index.html).

Shared mechanism: explicit update + required acknowledgment + legitimate challenger + bounded template.

## 6. Dissent, groupthink, and decision quality

Janis [BOOK, 1972/1982]: cohesion + insulation + directive leadership → concurrence-seeking. Critique: retrospective cases selected on outcome; lab support inconsistent; model overspecified [PAPER, Esser 1998; ⚠ mixed].

What survives is **authenticity**: minority/authentic dissent produced more and better solutions than all three devil's-advocate variants, while role-played DA mainly produced **cognitive bolstering of the initial view** [PAPER](https://doi.org/10.1002/ejsp.58). Norms matter independently: critical-norm groups out-decided consensus-norm groups [PAPER](https://doi.org/10.1037/0022-3514.80.6.918). Costs: structured confrontation improves quality but lowers satisfaction and acceptance, risking implementation failure [PAPER, Schweiger 1986; ⚠]. Delphi and nominal group technique separate generation from evaluation; nominal groups beat interacting groups on idea generation [PAPER, Diehl & Stroebe 1987; ⚠].

## 7. Distributed cognition and situation awareness

Hutchins: cognition is distributed across people, artifacts and representations — the cockpit "remembers" speeds via instruments and checklists, so the **unit of analysis is the system** [PAPER](https://doi.org/10.1016/0364-0213(95)90020-9), [PAPER](https://doi.org/10.1145/353485.353487). A manifest *is* team memory.

Endsley: SA = perception → comprehension → projection [PAPER](https://doi.org/10.1518/001872095779049543). Team SA = shared SA on common requirements + distributed SA on local ones. Rule: **share goals, plans, constraints, projections; keep percepts local**. Detection: SAGAT freeze-and-query works offline; online signals are behavioral (unanswered calls, no cross-checking, plan-continuation against evidence, stale entries). ⚠ No validated real-time team-SA detector; distributed-SA critics argue individual measures miss system properties (Stanton 2006).

## 8. Team size and coordination cost

Brooks: channels scale as n(n−1)/2, integration and ramp-up dominate, so adding people to a late project makes it later [BOOK, 1975]. Per-person effort falls with group size (Ringelmann; ⚠ magnitudes vary), and loafing is robust across 78 studies, attenuated by identifiability, meaningfulness and cohesion [PAPER](https://doi.org/10.1037/0022-3514.65.4.681), via diffusion of responsibility [PAPER](https://doi.org/10.1037/0022-3514.37.6.822).

Size effects are **non-monotonic, moderated by information-processing demand**: large top-management teams beat small ones in turbulent environments, lost in stable ones [PAPER](https://doi.org/10.2307/256761). ⚠ "Two-pizza teams" is practitioner folklore with no peer-reviewed test I found.

## 9. Design implications for AMP

| Object | Contents | Rationale |
|---|---|---|
| **Team manifest** | capabilities, authority, version, attestation time, evidence tier | explicit directory; no tacit TMS in agents |
| **Role** | authority + obligations + scope, bound to ID | scalable authority, stable identity |
| **Task board** | owner, state, dependency, deadline, warrant tier | one authoritative state |
| **Commitment record** | parties, proposition, satisfaction conditions, discharge/cancel/breach | no unilateral exit |
| **Handoff artifact** | SBAR/I-PASS fields + **synthesis-by-receiver** + open assumptions | forced grounding |

Rules: ground at **commitment boundaries**; distinguish `posted` from `grounded`; re-attest on capability/authority change; require a recorded authentic challenger for consequential calls; reject handoffs lacking receiver synthesis.

Signals: **duplicate work**; **stale directory** (attestation age, version skew, membership change); **ungrounded assumption** (low-tier warrant used for high-stakes action); **silent divergence** (conflicting projections); **commitment orphan** (no discharge event, unilateral cancel); **attention starvation** (grounding overhead crowding task work); **false consensus** (zero recorded dissent); **handoff without synthesis**. These overlay MAST's three clusters — system design, inter-agent misalignment, task verification (14 modes, κ=0.88, 1,600+ traces, 7 frameworks) [PAPER](https://arxiv.org/abs/2503.13657).

## 10. Confidence & gaps

**High**: SMM/TMS predict process and performance; checklist, I-PASS and debrief effects are quantified; authentic dissent beats role-played dissent; strong groupthink causality is unsupported. **Medium**: transfer to LLM agents; optimal team size; whether explicit manifests substitute for emergent TMS. **Flagged**: no machine-checkable joint-commitment semantics; no online team-SA metric; TMS evidence self-report and cross-sectional; MAST early and not independently replicated; Urbach 2014, Esser 1998, Schweiger 1986, Klein 2004, Diehl & Stroebe 1987, Janis, Brooks, Cannon-Bowers & Salas are cited from memory without verified links — leads, not confirmed quotes. Transfer is **analogical**: agents lack persistent memory and affect, so directories and commitments must be artifacts, not inferences — the most consequential inversion for AMP.
