# AMP Warrant Ledger — evidence brief

Labels: **[STANDARD]** W3C/IETF/spec · **[PAPER]** peer-reviewed or preprint · **[BENCHMARK]** dataset/eval. "Unverified" marks figures I could not check at source.

## 1. Provenance standards: minimal subset

PROV-O's "Starting Point" terms are the minimal subset: `Entity`, `Activity`, `Agent` plus `wasGeneratedBy`, `used`, `wasDerivedFrom`, `wasAttributedTo`, `wasAssociatedWith`, `actedOnBehalfOf` [STANDARD](https://www.w3.org/TR/prov-o/). Map claim→Entity, tool call→Activity, model→Agent; evidence→claim is `wasDerivedFrom`, author→`wasAttributedTo`. Add `prov:Bundle` per ledger segment and `prov:hadPrimarySource` to separate primary from secondary sources [STANDARD](https://www.w3.org/TR/prov-dm/); serialize as PROV-JSON [STANDARD](https://www.w3.org/TR/prov-json/). Drop collections, alternation and qualified-influence classes until needed.

**Critical gap:** PROV records causal derivation, not epistemic support. "Claim derived from document" ≠ "document supports claim." AMP needs a warrant edge PROV cannot express, layered on the PROV substrate.

## 2. Attribution/groundedness evidence

AIS: a statement is attributable if a generic hearer would affirm "according to sources C, S"—judged by humans, about *verifiability*, not truth [PAPER](https://arxiv.org/abs/2112.12870). Citation recall/precision across 1,450 queries and four commercial generative engines: **51.5%** of statements fully supported, **74.5%** of citations support their statement; precision correlated inversely with perceived utility (r = −0.96) [PAPER](https://arxiv.org/abs/2304.09848). ALCE: even the best systems lack complete citation support **50%** of the time on ELI5 [BENCHMARK](https://arxiv.org/abs/2305.14627).

Automatic attribution judging is hard: fine-tuned GPT-3.5 reaches only **~80 macro-F1** (binary) on AttributionBench, with errors concentrated in nuance and annotator-access mismatch [BENCHMARK](https://arxiv.org/abs/2402.15089). RAGAS defines faithfulness as supported claims / total claims, LLM-judged [PAPER](https://arxiv.org/abs/2309.15217).

**Do models cite sources they did not use?** Yes. A 2026 controlled reproduction finds post-rationalization—answer first, citation attached to a plausible passage—in **~1 in 7** citations on Wikipedia QA, and RLVR does not reduce it [PAPER](https://arxiv.org/abs/2609.23053). Across 13 LLMs, fabricated references range **14.23%–94.93%** [PAPER](https://arxiv.org/abs/2602.06718). A model citation is a claim *about* a source, not evidence of use: verify span overlap and entailment before crediting.

## 3. Hallucination detection reliability (numbers)

Taxonomy: faithfulness (to source) vs factuality (to world); intrinsic vs extrinsic; "confabulation" = arbitrary, seed-sensitive error [PAPER](https://pmc.ncbi.nlm.nih.gov/articles/PMC11186750/).

- Semantic entropy: mean **AUROC 0.790** across 30 task–model combinations vs 0.691 naive entropy, 0.698 P(True), 0.687 embedding regression; 0.78–0.81 across model families. It detects confabulations only, **not** systematic errors [PAPER](https://pmc.ncbi.nlm.nih.gov/articles/PMC11186750/).
- Hidden-state probes: **71–83%** binary accuracy, model-dependent [PAPER](https://aclanthology.org/2023.findings-emnlp.68/). SelfCheckGPT is black-box sampling consistency; no calibrated false-positive rate is reported [PAPER](https://aclanthology.org/2023.emnlp-main.557/).
- FActScore's automated estimator claims **<2%** error, but only relative to a reliable knowledge source [PAPER](https://arxiv.org/abs/2305.14251).

Benchmarks measure narrower things. TruthfulQA: best model **58%** vs **94%** human [BENCHMARK](https://arxiv.org/abs/2109.07958). FActScore: ChatGPT **58%** of atomic facts supported [BENCHMARK](https://arxiv.org/abs/2305.14251). SimpleQA (4,326 questions): GPT-4o **38.2%**, o1-preview **42.7%**, human **94.4%**, and stated confidence runs consistently above accuracy [BENCHMARK](https://arxiv.org/abs/2411.04368). AVeriTeC: 4,568 real claims, verdict κ = 0.619 [BENCHMARK](https://arxiv.org/abs/2305.13117); HaluEval: ~35k samples [BENCHMARK](https://arxiv.org/abs/2305.11747).

No detector yields a calibrated probability of truth. Treat scores as routing signals, not verdicts.

## 4. Evidence aggregation and independence

Independent testimony adds log-likelihood ratios; dependent testimony must not. A source's report is evidence about (a) the world and (b) the source's access and sincerity, so its LR is bounded by competence [BOOK](https://doi.org/10.1093/0199269750.001.0001).

**Double counting** is the dominant failure. Cluster by origin—root content hash, study, dataset, publisher—derived from `hadPrimarySource` and document identity; shared origin counts as one effective source. Pearl's d-separation shows why shared origins induce dependence—and why a common effect can too [BOOK](https://doi.org/10.1017/CBO9780511803161). Mechanically: `n_eff` = distinct origins, **not** number of URLs; weight duplicates ~0.1 rather than 1.0; cap corroboration credit at 2–3 origins.

Dempster–Shafer keeps explicit ignorance and conflict, but Dempster's rule assumes independence and behaves badly under high conflict; discount each source by reliability first, and use it only if "unknown" must be a first-class mass. Wisdom of crowds: Galton's 787 guesses gave median **1207 lb** vs true **1198 lb** (~0.8% error) [PAPER](https://doi.org/10.1038/075450a0), valid only under independence, diversity, decentralisation and aggregation. Shared feeds violate the first condition.

Score as `posterior logit = prior + Σ (reliability × independence) × bounded LR`.

## 5. Trust/testimony signals

Testimony is a basic evidence source; justification turns on source reliability rather than the hearer re-deriving everything [STANDARD/SEP](https://plato.stanford.edu/entries/testimony/). Fricker: credibility judgements are distorted by identity prejudice—testimonial injustice [BOOK](https://doi.org/10.1093/acprof:oso/9780198237907.001.0001). Epistemic vigilance: hearers check competence and benevolence, cheaply and fallibly [PAPER](https://doi.org/10.1111/j.1468-0017.2010.01394.x).

Signals with empirical support: replication/track record (**36/100** psychology studies replicated; **47%** of original effect sizes) [PAPER](https://doi.org/10.1126/science.aac4716); calibration/Brier scores on resolved claims; domain expertise; disclosed incentives; methodological transparency; retraction history. Weak signals: fluency, prestige, agreeing-source volume, self-confidence. Use per-source, per-domain Beta/Brier reliability updated only on *resolved* claims—never a global "trusted" flag.

## 6. Verifiable claims standards

VC 2.0—seven W3C Recommendations, 15 May 2025—gives issuer/holder/verifier, selective disclosure and status lists: right for cross-organisation attestations, overkill inside one runtime [STANDARD](https://www.w3.org/TR/2025/REC-vc-data-model-2.0-20250515/). JWT claim sets are the cheapest signed, tamper-evident envelope for tool receipts [STANDARD](https://www.rfc-editor.org/rfc/rfc7519.html). C2PA 2.2 (May 2025) defines manifests/assertions for media provenance—overkill for text, useful when the evidence is an image, video or PDF [STANDARD](https://c2pa.org/specifications/specifications/2.2/index.html). Transparency logs: CT (RFC 9162) and SCITT (RFC 9943, June 2026)—signed statement plus receipt, non-equivocation; SCITT states that transparency does not prevent dishonest issuers, only holds them accountable [STANDARD](https://www.rfc-editor.org/rfc/rfc9943.html).

Recommendation: hash and sign every claim/evidence pair; use VC only at org boundaries; log only when dispute cost exceeds logging cost; skip C2PA unless media is the evidence.

## 7. Audit and evidence bundles

Bundle: manifest (JSON-LD), content hashes of inputs/outputs, model + version, prompt template, decoding parameters/seed, retrieval queries with frozen result snapshots, timestamps, agent IDs, warrant graph, environment digest. RO-Crate 1.1 packages data with metadata in RO-Crate JSON-LD [STANDARD](https://www.researchobject.org/ro-crate/specification/1.1/); a PROV Bundle carries provenance-of-provenance; PROV-JSON is the interchange form. The NeurIPS reproducibility checklist is the closest field standard [PAPER](https://arxiv.org/abs/2003.12206).

Replay cannot be bit-exact across hardware and batching: store outputs plus logprobs, and define replay as *re-verification against frozen evidence*, not regeneration.

Privacy: store salted hash commitments, a minimal redacted span and an access policy; disclose full text only under VC/selective-disclosure authorisation.

## 8. Automated fact-checking limits

Pipeline: claim detection → evidence retrieval → verdict SUPPORTS / REFUTES / NOT ENOUGH INFO. FEVER: 185,445 claims; the original pipeline reached **31.87%** with gold evidence and **50.91%** without [BENCHMARK](https://arxiv.org/abs/1803.05355). AVeriTeC: 4,568 real claims from 50 organisations with temporal and multi-hop constraints (leaderboard figures unverified) [BENCHMARK](https://arxiv.org/abs/2305.13117). ClaimReview/schema.org markup records `itemReviewed`, `reviewRating` and `publisher` as an attestation by a named human fact-checker, not an automated verdict format [STANDARD](https://schema.org/ClaimReview).

Failure modes: retrieval miss, temporal leakage, implicit or compound claims, context dependence, adversarial phrasing, NEI over/under-prediction. Accuracy on curated sets does not transfer to the open web.

**Never fully automate:** public/political verdicts, legal/medical/safety claims, allegations about named people, intent or sanctions attribution, anything triggering irreversible action. Automation may triage, retrieve and draft; a human signs the verdict.

## 9. Design implications: schema + scoring + dispute protocol

**Minimal schema** (JSON, PROV-aligned):
- `Claim {id, text, proposition, scope, type: observation|inference|testimony, asserted_by, asserted_at, status, supersedes}`
- `Evidence {id, kind, source{uri, sha256, version, captured_at}, locator{span, quote_sha256}, sensitivity, trust_tier}`
- `Warrant {id, claim_id, evidence_id, relation: supports|undercuts|contradicts, strength, rule, origin_id, independence_group, evaluator, evaluated_at}`
- `Activity {id, agent_id, used[], generated[], at}`

**Scoring.** Use bounded log-LR tiers (weak 0.5, moderate 1.0, strong 2.0 nats) rather than free floats; `posterior = prior + Σ discount × LR`; publish posterior, effective origins and the weakest link. Independence: `origin_id` from the provenance root, duplicates weighted 0.1, `n_eff` = distinct origins; reserve "corroborated" for ≥2 distinct origins. Trust tiers: T0 direct tool observation, T1 hashed primary document, T2 standard/peer-reviewed, T3 secondary reporting, T4 anonymous/unverified; tier caps maximum posterior and triggers review.

**Dispute/repair.** (1) Challenge with `claim_id` + ground; (2) freeze the claim, mark dependents conditional; (3) burden shifts to the assertor to produce or repair the warrant; (4) an independent adjudicator scores it against a rubric; (5) repair by superseding—never editing—and invalidate dependents via PROV; (6) log the dispute itself as an Activity.

**Human review:** high-stakes domains, single-origin claims, claims contradicting consensus, person-attributing claims, T4 evidence, unresolved disputes.

**Audit without raw data:** per-bundle Merkle root, salted hashes, redacted spans, selective disclosure.

## 10. Confidence & gaps

High confidence: standards scope; citation-unreliability magnitudes; semantic entropy's AUROC and confabulation-only scope; benchmark narrowness. Medium: the ~80 F1 attribution ceiling; the 1-in-7 figure (one 2026 reproduction); replication rate as a trust prior.

Low/unverified: the scoring numbers (0.1 discount, 0.5/1/2 nats, tier caps) are **proposals, not validated parameters**. No standard measures warrant strength or independence; no benchmark scores bundle quality; Dempster–Shafer remains contested for correlated testimony; long-form, multilingual and time-sensitive factuality remain open. Human-review cost binds.
