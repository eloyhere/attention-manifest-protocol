# Other Minds: empirical state of the art and failure modes for AMP

Numbers are each paper's own re-implementation on sampled subsets; cross-paper scores are **not** comparable (different prompts, subsets, metrics).

## 1. Benchmark table and current results

| Benchmark | Measures | Scores | Where it fails |
|---|---|---|---|
| **ToMi** [BENCHMARK] ([Le et al. 2019](https://aclanthology.org/2024.acl-long.466.pdf); rerun [Zhou et al. 2026, Tbl. 1](https://arxiv.org/html/2509.00559v3)) | 1st/2nd-order false belief, object location, templated | GPT-4o .81→.93 w/ structured state; o1 .95→.99; R1 .95→.98 | Near ceiling; tests template-following |
| **ParaToMi** [BENCHMARK] ([ibid.](https://arxiv.org/html/2509.00559v3)) | Same, paraphrased to kill lexical shortcuts | GPT-4o .82→.91; o1 .84→.93 | 6–8 pt drop = paraphrase sensitivity |
| **HiToM** [BENCHMARK] ([Wu et al. 2023](https://arxiv.org/html/2509.00559v3)) | Higher-order belief + deception, joint attention | o1 .87→.88; **R1 .42→.51** | Model-dependent collapse; order label unreliable (§2) |
| **FANToM** [BENCHMARK] ([Kim et al. 2023](https://github.com/skywalker023/fantom)) | Multi-party dialogue, speakers join/leave; strict "all Qs per snippet" | .06 (o3-mini) to .62 (o1) | **The real cliff**: templates ≠ tracking who was in the room |
| **OpenToM** [BENCHMARK] ([Xu et al., ACL 2024](https://arxiv.org/abs/2402.06044)) | Physical (location) vs **psychological** (preference, attitude) ToM | Strong physical, weak psychological | Unfaithful reasoning; length- and role-sensitivity |
| **BigToM** [BENCHMARK] ([Gandhi et al., NeurIPS 2023](https://papers.nips.cc/paper/2023/hash/2b9efb085d3829a2aadffab63ba206de-Abstract-Datasets-and-Benchmarks.html)) | 3,000 procedural narratives; forward/backward belief *and* action | Not verified here — **flagged** | Built as template-diverse ToMi successor |
| **SOTOPIA/-hard** [BENCHMARK] ([Zhou et al. 2024](https://arxiv.org/abs/2310.11667)) | First-person interactive goals; completion, believability | GPT-4 **significantly below humans**; structured state +18% | Long-horizon ToM, strategic communication |

**Contamination.** [HopToM](https://arxiv.org/abs/2610.17777) formalizes *effective order* and finds "widespread order inflation across existing benchmarks" — k-th-order items answerable from lower-order evidence. [Ullman (2023)](https://arxiv.org/abs/2302.08399) shows semantics-preserving edits flip results; [OpenToM](https://arxiv.org/abs/2402.06044) manually revised 17.8% of narratives to remove lexical shortcuts. Treat single ToM numbers as contaminated until paraphrased and order-certified.

## 2. Nested-belief depth evidence

The one clean curve: [HopToM](https://arxiv.org/abs/2610.17777), certified full-order items, four frontier LLMs, direct prompting — **73.5% at 1st order → 20.0% at 4th**; humans also struggle. Interventions trace errors to evidence for *shallower belief prefixes*. Encoding each interaction once into **perspective records** and resolving nested queries deterministically (HopTrace) gains **+22.0 pts at 4th order, +38.5 at 5th**, with 20–39× fewer tokens than multi-call methods. Implication: depth 2 is defensible; depth 3+ must be *computed from an explicit record*, not elicited by prompting.

## 3. Computational ToM (what is implementable)

- **ToMnet** [PAPER] ([Rabinowitz et al., ICML 2018](https://arxiv.org/abs/1802.07740)) — meta-learns agents from behaviour; belief state is **emergent and opaque**, unusable as an auditable structure.
- **Bayesian ToM / inverse planning** [PAPER] ([Baker et al. 2017](https://doi.org/10.1038/s41562-017-0064)) — posterior over beliefs/desires/percepts with real uncertainty; **implementable**, but needs a domain model and action likelihood.
- **AutoToM** [PAPER] ([Zhang et al., NeurIPS 2025 spotlight](https://arxiv.org/abs/2502.15676)) — automated inverse planning with LLM backend, refined by **inference uncertainty**; interpretable, online, no hand-built model. Best AMP match.
- **K-R / level-k** [PAPER] ([Zhang et al., NAACL 2025](https://aclanthology.org/2025.naacl-long.370/)) — explicit recursion depth as a parameter; makes depth cap a legitimate knob.
- **S3AP** [PAPER] ([Zhou et al. 2026](https://arxiv.org/html/2509.00559v3)) — Dec-POMDP-style explicit state (environment, per-agent observations, actions, mental states): **+51% FANToM over o1, +18% SOTOPIA-hard, 30/35 cells improved**. Ablation: gain comes from *stating* social information, not JSON (bullets ≈ JSON); a weaker parser helps a stronger reasoner (o3-mini parse lifts o1 ParaToMi 83.5→94.3%). Authors' own caveat: **no memory field**, so long-horizon recall is unguaranteed — exactly AMP's gap.

## 4. Product user-modeling practice and failures

Production representations are coarse: a flat, user-visible summary of facts, **scoped** rather than global. Claude memory is per-project, exposes an editable summary, offers incognito, is admin-disableable, and was safety-tested for "over-accommodation" and reinforcing harmful patterns [BLOG] ([Anthropic 2025](https://claude.com/resources/articles/memory)). OpenAI's ChatGPT memory docs describe editable saved memories [BLOG] ([learn.chatgpt.com](https://learn.chatgpt.com/docs/customization/memories)) — *unfetchable this session; unverified*.

The documented failure mode is a **self-reinforcing privacy loop** [PAPER] ([Kaneko et al. 2026](https://arxiv.org/abs/2610.28315)): memory-conditioned replies carry earlier values forward, often as **presuppositions**; users affirm or don't correct; the agent's guesses become recorded values; leakage grows across sessions. Users cannot exit — correcting discloses, declining shifts predictions toward sensitive values, wrong values entrench. The effective fix is at the **response**: forbidding the agent to state or presuppose attributes returns leakage to near no-memory level while keeping most quality gains; filtering user text or stored memory sacrifices much of the benefit.

## 5. Grounding: when to ask

Grounding is collaborative — **grounding acts** (acknowledge, repair, clarify) under **least collaborative effort**, minimizing *joint* work, not individual effort [PAPER] ([Clark & Brennan 1991](https://doi.org/10.1037/10096-006)).

- **EVPI-gated clarification** [PAPER] ([Suri et al., ACL Findings 2026](https://aclanthology.org/2026.findings-acl.2028/)) separates *specification* from *model* uncertainty and scores questions by expected value of perfect information minus aspect cost: 7–39% higher coverage with **1.5–2.7× fewer** questions. Baseline when-to-call accuracy is **36.5%** (→65.2% with uncertainty-weighted training) — models are bad at *when*, not just *what*.
- **Timing curves** [PAPER] ([Gulati et al. 2026](https://arxiv.org/abs/2605.07937)): 84 variants, 6,000+ runs. **Goal** clarification loses nearly all value after ~10% of execution (0.78 → 0.40 baseline); **input** holds to ~50%; deferring past mid-trajectory is **worse than never asking**. No frontier model asks inside the optimal window: GPT-5.2 52% of sessions at mean 43%, Claude Sonnet 4.5 23% at 50%, Gemini 3 Flash **0%**.
- Repair-oriented question generation is trainable [PAPER] ([ClarifyDelphi, ACL 2023](https://aclanthology.org/2023.acl-long.630/)).

## 6. Multi-agent knowledge/incentive modeling

Classical vocabulary is BDI and epistemic logic (possible worlds) — intractable in full, and not what working systems use [**unverified**: no primary source fetched]. What recent systems actually do: Dec-POMDP-style per-agent observation and mental-state fields ([S3AP](https://arxiv.org/html/2509.00559v3)), explicit recursion depth ([K-R](https://aclanthology.org/2025.naacl-long.370/)), uncertainty-ordered refinement ([AutoToM](https://arxiv.org/abs/2502.15676)). For incentives and deception, [MACHIAVELLI](https://arxiv.org/abs/2304.03279) measures power-seeking and ethical violations over 134 text games and finds real tension between reward and ethics — an agent that models beliefs also models *exploitability*. SOTOPIA provides the cooperative/competitive testbed.

## 7. Privacy/ethics safeguards

- **Never presuppose inferred attributes in text** — the best-measured intervention ([Kaneko et al.](https://arxiv.org/abs/2610.28315)).
- **Scope + user control**: per-project isolation, editable summary, incognito, admin disable ([Anthropic](https://claude.com/resources/articles/memory)).
- **Stereotyping**: models already exploit lexical/role cues and are role-sensitive ([OpenToM](https://arxiv.org/abs/2402.06044)); trait inference from sparse behaviour is what confidence fields must absorb.
- **Overconfident intent**: shallow-prefix errors ([HopToM](https://arxiv.org/abs/2610.17777)) mean confident "they want X" is often 1st-order evidence wearing a 2nd-order label.
- **Over-accommodation/parasocial drift**: flagged as memory-specific by Anthropic ([BLOG](https://claude.com/resources/articles/memory)); no peer-reviewed measurement I could verify — **gap**.

## 8. Design implications for AMP

Every field is an evidence-bearing claim, never a bare fact.

```yaml
OtherModel:
  agent_id, kind(human|agent), version(int), updated_at
  claims:
    - slot: belief|goal|knowledge|preference|attention|trust|capability
      content: "<one proposition>"
      order: 0|1|2        # 0=about them, 1=their belief about me, 2=their belief about my belief
      confidence: 0..1
      source: asserted_by_user|observed_action|inferred|imported
      evidence: [turn_ids]
      volatility: stable|session|volatile ; ttl
  common_ground:          # mutual knowledge; requires an acknowledged grounding act
    - proposition, grounding_act: turn_id, confidence
  attention: {state: focused|interruptible|away, evidence, ttl}
  unknowns: ["<explicitly not modeled>"]   # first-class; caps over-modeling
```

**Rules.** (1) **Depth cap 2**; order 3 only in explicit negotiation and only if computed from the perspective record — downgrade and inflate uncertainty per level. (2) **No laundering**: `inferred` never becomes `asserted`. (3) **Decay**: volatile TTL = session; stable re-confirmed every N sessions or on contradiction; expiry marks **stale**, never silent delete. (4) **Never store**: inferred sensitive attributes (health, politics, religion, sexuality, ethnicity, mental health, finances), third-party identities, incognito-scope content, verbatim quotes about absent others. (5) **No presupposition** — surface nothing the user did not state. (6) **Ask gate** = EVPI > interruption cost; validate goal/constraint in the first ~10% of a trajectory, input by ~50%, never after mid-trajectory. (7) **Contradiction → repair act**, not overwrite: keep both versions, log the correction. (8) **Negotiation payload** `{what, why, cost, fallback, expiry}`; defer/handoff explicit and revocable. (9) **Inspectable**: view, edit, export, scope, kill switch. (10) **Score it**: grade user-directed predictions (Brier) — an OtherModel is a forecast, not a portrait.

## 9. Confidence & gaps

**High**: 1st-order saturation vs multi-party/higher-order brittleness; order inflation; EVPI and timing results; the memory privacy loop.
**Medium**: OpenToM's physical/psychological gap magnitude; BigToM scores; product internals (one page unfetched).
**Gaps**: no benchmark measures *versioned* user models, attention negotiation, or calibration of OtherModel claims against ground truth; no published uncertainty-bearing OtherModel schema; ToMnet-style models untested for interactive agents; depth-cap evidence comes from narrative QA, not live user modeling. §8 is a synthesis, not a validated design: rules 1–3 are empirically motivated, 4–10 precautionary.
