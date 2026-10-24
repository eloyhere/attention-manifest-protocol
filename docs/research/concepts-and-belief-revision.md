# AMP Warrant Ledger: representation, revision, contradiction — research brief

## 1. Concept theories → data model implications

| Theory | Commitment | JSON shape it forces | Verdict for AMP |
|---|---|---|---|
| Classical | Necessary & sufficient conditions; definitional structure [TEXTBOOK](https://plato.stanford.edu/entries/concepts/) | `guard: {mustHave, mustLack}` | Kept only as a *validator*, never as identity |
| Prototype (Rosch) | Graded typicality, basic-level categories [PAPER](https://psycnet.apa.org/record/1976-00172-001) | `dims: Record<string, number>`, weighted slots | Primary membership semantics |
| Exemplar | Category = stored instances; similarity to instances | `exemplars: string[]` | Primary *grounding* mechanism (also cheapest for text) |
| Theory-theory | Coherence comes from an explanatory/causal theory, not features [PAPER](https://psycnet.apa.org/record/1985-30458-001) | `theoryRefs: claimId[]` | Explains why a concept is allowed to exist |
| Conceptual spaces (Gärdenfors) | Concepts = regions over quality dimensions; similarity = distance [PAPER](https://books.google.com/books?id=ikOTAQAACAAJ), [formalization](https://arxiv.org/abs/1801.03929) | numeric `dims`, region predicates | Supplies the *geometry* attention scoring needs |

No single theory suffices, and the classical theory is empirically untenable as a theory of categorization [TEXTBOOK](https://plato.stanford.edu/entries/concepts/). For concepts used to **compress attention**, the decisive requirements are cheap graded membership, one stable handle, and a distance metric — not inferential power. Hence prototype + exemplar + conceptual-space dimensions, with a thin classical guard for checkability. AMP already bets this way (`intension` + `grounding`).

## 2. Concept formation operations and failure modes

Copy **COBWEB**'s control structure, not its algorithm: incremental clustering that decides *create / merge / split* by one scalar, category utility [PAPER](https://dl.acm.org/doi/10.1023/A:1022852608280) — exactly the decision rule agent memories usually lack.

Analogy via **structure-mapping** [PAPER](https://archive.org/stream/gentner-d.-1983.-structure-mapping-a-theoretical-framework-for-analogy.-cognitiv/Gentner,%20D.%20(1983).%20Structure-Mapping%20A%20Theoretical%20Framework%20for%20Analogy.%20Cognitive%20Science,%207(2),%20155%E2%80%93170_djvu.txt): alignment is on *relational structure*. Implement as concept templates with slot substitution — an LLM emits the shared relation skeleton far more reliably than a definition.

Ops as recorded, not in-place: `merge` (keep both ids as aliases), `split` (new ids + `splitFrom`), `refine` (narrow `dims`/add guard), `retire` (status, never delete — retraction is evidence). Four failure modes each need a monitor: **over-general** (extension grows, intension static → coverage vs. precision audit), **drift** (exemplar-set Jaccard over windows), **incoherent extension** (mean pairwise similarity below cohesion floor), **vacuous label** (zero exemplars, or `tokensSaved ≤ 0` after N uses). Thresholds are engineering heuristics, not literature values — **[unverified]**.

## 3. KR stack trade-offs

Full OWL buys decidable inference AMP will never call; the W3C ships profiles (EL/QL/RL) precisely for tractability [STANDARD](https://www.w3.org/TR/owl2-profiles/). Tellingly, PROV-O — a W3C Recommendation — claims conformance only to OWL-RL [STANDARD](https://www.w3.org/TR/prov-o/). Property graphs have a standard query language (GQL) and win on multi-hop traversal **[link unverified: ISO/IEC 39075:2024]**.

Embedding-only fails exactly where AMP lives: GraphRAG shows plain RAG collapses on *global, corpus-level* questions and needs a pre-built entity graph plus community summaries [PAPER](https://arxiv.org/abs/2404.16130). Postmortem: Freebase, then the dominant open KB, was shut down and migrated into Wikidata — curation cost, not expressivity, killed it [STANDARD](https://www.wikidata.org/wiki/Wikidata:WikiProject_Freebase).

**Recommendation:** typed JSON/TypeScript as source of truth; PROV-O *term names* as JSON-LD keys; SHACL-style validators as runtime guards [STANDARD](https://www.w3.org/TR/shacl/); no reasoner; optional graph projection for queries only.

## 4. AGM/TMS: what to implement literally

AGM gives a beautiful characterization and an unusable algorithm: partial-meet contraction quantifies over remainder sets, exponential in |K| [TEXTBOOK](https://plato.stanford.edu/entries/logic-belief-revision/).

- **Implement literally:** expansion (append); the **entrenchment order** (total preorder over claims); and entrenchment-based contraction — "give up the least entrenched first", which is provably equivalent to transitively relational partial-meet contraction, without enumerating remainders [TEXTBOOK](https://plato.stanford.edu/entries/logic-belief-revision/).
- **Do not implement:** Recovery (contested, and wrong for a system that must forget untrusted sources); full belief-set closure (implies logical omniscience); ATMS environments (exponential; only worth it for multi-context hypothetical reasoning).
- **Use as tests, not algorithms:** Darwiche–Pearl DP1/DP2 for iterated revision discipline.
- **Implement JTMS-style labels** (IN/OUT over a justification graph). It is the same dependency graph you need to answer "what breaks if I retract this?", and retraction cost is linear in the graph.
- **Swap in credences** for anything graded: AGM has no representation of uncertain belief; the Lockean threshold route yields inconsistent conjunctions (p and q believed, p∧q not), which Leitgeb's criterion repairs at the cost of a world-partition [TEXTBOOK](https://plato.stanford.edu/entries/logic-belief-revision/). Practical rule: store credence, derive `asserted` as `conf ≥ τ ∧ no active defeater`.

## 5. Contradiction handling algorithms

Three conflict classes mirror the LLM literature's context–memory, inter-context, intra-memory split [PAPER](https://arxiv.org/abs/2403.08319). Ladder, cheapest first:

1. **Key-based detection** — index on canonical `(subj, pred, scope)`; O(n log n), catches most intra-ledger conflicts.
2. **Defeaters over deletion** — `undercut` (attacks the warrant) vs `rebut` (attacks the claim). Never mutate; mark and keep both.
3. **Local repair via JTMS** — retract the minimal support set; usually terminates without global search.
4. **Weighted MaxSAT for global repair** — exactly the BeliefBank architecture: hard clauses for high-tier claims, soft weights from confidence, MaxSAT solver revises clashing beliefs [PAPER](https://arxiv.org/abs/2109.14723). Best available precedent for AMP; still worst-case exponential.
5. **ProbLog / probabilistic logic** when truth is graded rather than binary [docs](https://problog.readthedocs.io/).
6. **Dung argumentation** when the conflict is between *arguments*, not facts: the grounded extension is exactly "what may enter the Frame" [PAPER](https://doi.org/10.1016/0004-3702(94)00041-X) **[DOI unverified]**.

Minimal-change semantics = step 3, escalate to 4 only if local repair leaves a residual conflict.

## 6. Provenance, time, trust

Reuse PROV-O's vocabulary, not its ontology: `prov:wasDerivedFrom`, `prov:wasAttributedTo`, `prov:generatedAtTime`, `prov:invalidatedAtTime`, `prov:wasRevisionOf`, `prov:hadPrimarySource` [STANDARD](https://www.w3.org/TR/prov-o/). PROV's generation/invalidation gives one axis; add the **belief axis** — `recordedAt` / `retractedAt` — so "believed at t1, retracted at t2" is bitemporal, not a mutation.

Trust must be **ordinal** (tier), orthogonal to confidence: tier *caps* confidence, it does not average into it. For multi-source fusion, Subjective Logic's opinion `(belief, disbelief, uncertainty, base rate)` and its cumulative-fusion operator are the right formalism [TEXTBOOK](https://books.google.com/books?id=nqRlDQAAQBAJ) — but fusion assumes source independence, which same-model/same-prompt evidence violates. Hence `independenceGroup` is mandatory, not optional.

## 7. Entity identity

Standard pipeline: blocking → pairwise matching → clustering → canonicalization [PAPER](https://arxiv.org/abs/2008.04443). MVP: deterministic keys (URL, DOI, provider id) resolve free; only *candidate pairs sharing a concept or attribute* go to embedding + LLM adjudication; store match probability and the evidence. Ids are ULIDs, never labels; `merge` keeps both ids as aliases, `split` creates new ids with `splitFrom`. PROV's `alternateOf` / `specializationOf` cover the vocabulary [STANDARD](https://www.w3.org/TR/prov-o/).

## 8. Belief consistency in LLMs

The empirical base is blunt: a claim's stability is a property of (model, prompt, context), not of the model. PTLMs give inconsistent answers to probing questions even after specialized training [PAPER](https://arxiv.org/abs/2109.14723); prompt *formatting* alone moves accuracy by up to 76 points [PAPER](https://arxiv.org/abs/2310.11324); stated positions shift under user pressure (sycophancy) [PAPER](https://arxiv.org/abs/2310.13548); verbalized confidence is poorly calibrated [PAPER](https://arxiv.org/abs/2306.13063).

→ The ledger stores **context-fingerprinted assertions**, not beliefs. Every claim carries `assertedBy{model, promptHash, contextId}`. Re-asking is a *measurement*; disagreement between two probes is variance to record, not an error to resolve. A claim never earns authority from "the model said so" — tier comes from evidence kind. The metaphysical claim "LLMs have no beliefs" is interpretation; only the consistency results are verified **[flagged]**.

## 9. Design implications

```ts
type Tier = 0|1|2|3; // 0 observation, 1 document, 2 inference, 3 conjecture
type Status = "active"|"contested"|"retracted"|"superseded"|"label_only";
interface Prov { sourceId: string; retrievedAt: string; digest: string;
                 independenceGroup: string; derivedFrom?: string[]; }
interface Concept {
  id: string; label: string; handles: string[];          // label is a handle, not identity
  dims: Record<string, number>;                          // conceptual-space region
  exemplars: string[];                                   // 0 => status "label_only"
  counterExemplars: string[];                            // anti-vacuity
  guard?: { mustHave?: string[]; mustLack?: string[] };  // thin classical check
  theoryRefs?: string[];                                 // claims explaining coherence
  uses: number; tokensSaved: number;                     // compression payoff
  status: Status; prov: Prov;
  ops: Array<{op:"merge"|"split"|"refine"|"retire"; at:string; from?:string[]; note:string}>;
}
interface Claim {
  id: string; subj: string; pred: string; obj: unknown; neg?: true;
  scope?: { validFrom?: string; validTo?: string; conditions?: string[] };
  conf: number; tier: Tier; warrant: string[];           // [] => conjecture only
  defeaters: Array<{ id: string; kind: "rebut"|"undercut"; active: boolean }>;
  status: Status; supersedes?: string;
  assertedBy?: { model: string; promptHash: string; contextId: string };
  recordedAt: string; retractedAt?: string; prov: Prov;
}
```

Rules: **R1** append-only; supersede, never mutate. **R2** `conf ≤ tierCeiling[tier]`; warrant empty ⇒ tier 3. **R3** conflict = same `(subj,pred)`, incompatible `obj`, overlapping validity ⇒ `contested` on both, both enter Frame with their confidences. **R4** retraction demotes only JTMS descendants; no cascade delete. **R5** confidence along inference = weakest link (`min`), then fused across independent sources via Subjective Logic. **R6** vacuous guard: `exemplars.length === 0 ∨ counterExemplars.length === 0` ⇒ `label_only`, excluded from Frame. **R7** drift guard: exemplar Jaccard < θ over window ⇒ propose `split`. **R8** no concept enters the Frame without `theoryRefs.length > 0` or ≥2 exemplars. **R9** `tokensSaved ≤ 0` after 20 uses ⇒ `retire`.

`AttentionFrame.slots` reference `concept.id`/`claim.id` with a VOI score; `ignored[]` records `{ref, reason}` — the ledger's value is the *ignored* list.

## 10. Confidence & gaps

Verified in full text this session: the SEP entries on concepts and belief revision, PROV-O, and abstracts of BeliefBank, GraphRAG, the knowledge-conflicts survey, entity resolution, prompt-format sensitivity, sycophancy, and confidence elicitation. Weaker: Rosch 1975, Murphy & Medin 1985 and Gärdenfors 2000 are cited via record pages, not full text; Dung 1995 DOI and the GQL ISO number are **[unverified]**; the concept-drift survey was not retrieved, so drift thresholds are my proposal. No head-to-head benchmark exists for MaxSAT belief repair at agent scale (BeliefBank used a few thousand beliefs) **[unverified extrapolation]**. The "concept = compression operator" framing is synthesis: chunking is established, the compression-theoretic reading is not. Biggest design risk: treating the ledger as an epistemic achievement rather than a bookkeeping device that makes disagreement *visible*.
