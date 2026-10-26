# Attention Manifest Protocol — research brief

Quantitative core for (a) salience scoring and (b) interruption decisions. Labels: [PAPER] [BOOK] [INDUSTRY] [REG]. Unverified items are marked.

## 1. Attention-as-resource: vocabulary and formal models

Simon (1971) is the origin point: information consumes attention, so "a wealth of information creates a poverty of attention," and the cost of a message is the recipient's time, not its bytes [BOOK](https://www.ubs.com/global/en/our-firm/what-we-do/our-brand/nobel-perspectives/laureates/behavioral-economics/attention-economy.noheader.html). Davenport & Beck (2001) codified the managerial vocabulary — attention scarcity, attention as currency, allocation [BOOK]. Vocabulary that will survive review: *attention scarcity, opportunity cost of attention, attention allocation, attention budget, interruption cost, attention rent*.

Two formal traditions exist, and neither is agent-native:

- **Rational inattention** (Sims 2003): the agent selects an information channel subject to Shannon capacity; attention is measured in bits and processed optimally under a cost [PAPER](https://doi.org/10.1016/S0304-3932(03)00021-4). This is the cleanest formal home for "context tokens as a budget."
- **Attention economies** (Falkinger 2007, *JET*): general-equilibrium allocation of attention across messages and senders [PAPER](https://zbmath.org/1280.91143).

There is no accepted standard optimization model of a *multi-dimensional* attention budget for agents. That is a genuine gap AMP can occupy — say so explicitly rather than implying one exists.

## 2. VOI / EVSI formulas and approximations

Setup: state θ ~ p(θ), action a, utility u(a,θ), candidate observation X with cost c(X).

```
EVPI    = E_θ[ max_a u(a,θ) ] − max_a E_θ[ u(a,θ) ]
EVSI(X) = E_X[ max_a E_{θ|X} u(a,θ) ] − max_a E_θ[ u(a,θ) ]
Net value = EVSI(X) − c(X);  collect iff Net > 0
```

Lineage: Raiffa & Schlaifer (1961) [BOOK]; Howard (1966) named information value theory [PAPER](https://doi.org/10.1109/TSSC.1966.300074). EVSI needs a nested expectation over prior and data; the standard practical estimator is regression/Monte-Carlo over probabilistic-sensitivity samples (Strong, Oakley & Brennan 2014) [PAPER].

LLM-specific problem: p(θ|X) is not given. You must elicit it (sampled self-consistency, ensembles) and calibrate it; EVSI is then only as trustworthy as that calibration. Direct precedent: Dong et al. (2026) build an inference-time VoI rule for whether an agent should ask a clarifying question, trading expected utility gain against the "cognitive cost imposed on users," with no hyperparameter tuning and up to +1.36 utility points over tuned baselines across four domains [PAPER](https://arxiv.org/abs/2601.06407). Related: VOILA applies VoI to retrieval-fidelity selection (50–60% cost reduction at 90–95% of full accuracy) [PAPER](https://arxiv.org/abs/2602.03007); CruxBench grades questions by VOI and finds frontier models only narrowly beat a random-timing baseline [PAPER](https://arxiv.org/abs/2609.35879).

## 3. Information gain methods

Expected information gain is mutual information (Lindley 1956):

```
EIG(X) = I(θ;X) = H(θ) − E_X[ H(θ|X) ] = E_X[ KL( p(θ|X) ‖ p(θ) ) ]
```

[PAPER](https://doi.org/10.1214/aoms/1177728069)

BALD (Houlsby et al. 2011): `argmax_x H(y|x) − E_{θ~p(θ|D)}[ H(y|x,θ) ]` [PAPER](https://arxiv.org/abs/1112.5745). Disagreement variant: query-by-committee vote entropy.

Costs and failure modes: MC estimation over M posterior samples × N candidates is O(MN) forward passes; ensembles/MC-dropout are only a proxy posterior; EIG is myopic (one step), ignores downstream option value, and is not cost-sensitive unless wrapped in EVSI. Batch variants exist to avoid near-duplicate selections.

## 4. Interruption cost: exact numbers and study quality

**The 23:15 claim is not supported as usually cited.** Mark, Gudith & Klocke (2008) is a lab experiment (48 participants, students, per full-text reviews; the abstract gives no N) whose actual finding is close to the opposite of the folk version: interrupted tasks were completed *faster* with no quality loss, but with more stress, frustration, time pressure and effort [PAPER](https://doi.org/10.1145/1357054.1357072) ([PDF](https://ics.uci.edu/~gmark/chi08-mark.pdf)). The paper contains no 23-minute figure. Mark et al. (2005) observed 24 information workers and reported *fragmentation* — 57% of working spheres interrupted before switching, most internal/personal — not a refocus latency [PAPER](https://doi.org/10.1145/1054972.1055017). The 23:15 number is press folklore attached to Mark's name; do not cite it.

Monk, Trafton & Boehm-Davis (2008): three experiments, interleaved-task paradigm; longer and more demanding interruptions produce longer resumption times, consistent with memory-for-goals decay over roughly 1 minute [PAPER](https://doi.org/10.1037/a0014402). Exact millisecond means are behind the paywall — quote direction, not numbers.

Iqbal & Horvitz (2007): field study logging real suspensions and resumptions of computing tasks; establishes that resumption is measurable in situ and that timing dominates cost [PAPER](https://doi.org/10.1145/1240624.1240730).

**Phantom citation check:** no paper titled "Would you learn to live with a 5-second delay?" by Hudson et al. exists in OpenAlex, Crossref, or the open web. The nearest real work is NotiModes (MuC 2020), which studies notification delay modes [PAPER](https://doi.org/10.1145/3404983.3410006). Drop the Hudson citation.

What the evidence does *not* support: a universal constant "cost per interruption." Effects are task-, timing- and person-dependent; Mark (2008) found personality measures predicted disruption cost.

## 5. Interruptibility and batching policies with evidence

Horvitz et al. (2003, *CACM*) frame attention as inference: estimate an expected cost of interruption (ECI) from context and interrupt only when expected value exceeds it [PAPER](https://doi.org/10.1145/636772.636798). Coordinate (2002) forecasts presence/availability; Bayesphone (2005) precomputes context-sensitive policies [PAPER].

- **Iqbal & Bailey (2008):** deferring notifications to detected task breakpoints reduced frustration and reaction time versus immediate delivery [PAPER](https://doi.org/10.1145/1357054.1357070).
- **Fitz et al. (2019):** randomized field experiment, n = 237. Batching notifications 3×/day made participants feel more attentive, productive, in a better mood and more in control, with lower stress and fewer phone interruptions; the "no notifications" arm gained few benefits and reported more anxiety and FoMO [PAPER](https://doi.org/10.1016/j.chb.2019.07.016). Strongest causal evidence for batching.
- **Ancker et al. (2017):** 112 primary-care clinicians, 2010–2013. One quarter of drug alerts and one third of reminders were repeats; reminder acceptance fell 30% per additional reminder per encounter and 10% per 5-percentage-point rise in repeated reminders; no desensitization over time for a newly deployed alert [PAPER](https://doi.org/10.1186/s12911-017-0430-8). Implication: **repetition, not volume alone, drives fatigue.**

## 6. Salience models and habituation

Bottom-up: Itti & Koch (2001) compute feature maps → saliency map → winner-take-all [PAPER](https://doi.org/10.1038/35058500); top-down goals modulate selection (feature integration theory, Treisman & Gelade 1980 [PAPER](https://doi.org/10.1016/0010-0285(80)90005-5)). Habituation is a well-characterized decrement under repeated stimulation (Rankin et al. 2009 [PAPER](https://doi.org/10.1016/j.nlm.2008.09.012)) and is the mechanism behind alert fatigue above.

Structurally borrowable, not literally: (a) one normalized salience scale across heterogeneous candidates; (b) a habituation term growing with recent same-class interrupts; (c) inhibition of return on recently surfaced items; (d) novelty as Bayesian surprise rather than recency. Caveat: saliency models are visual and were never validated on semantic/task content — use as a prior, never as a measurement.

## 7. Attention capture, ethics, regulation

Narayanan et al. (2020) crawled ~11K shopping sites / ~53K pages and found 1,818 dark-pattern instances across 15 types and 7 categories; 183 sites used deceptive practices; 22 third-party providers sold turnkey dark patterns [PAPER](https://doi.org/10.1145/3359183).

Regulation: EU AI Act Art. 5(1)(a) prohibits AI systems using subliminal, purposefully manipulative or deceptive techniques that materially distort behaviour and cause significant harm [REG](https://artificialintelligenceact.eu/article/5/); DSA Art. 25 bars interface designs that deceive or impair free and informed decisions [REG](https://eur-lex.europa.eu/eli/reg/2022/2065/oj); the FTC's 2022 dark-patterns report sets out the enforcement theory [REG](https://www.ftc.gov/reports/bringing-dark-patterns-light); the UN Economist Network (2023) documents attention-economy harms [INDUSTRY](https://www.un.org/sites/un2.un.org/files/attention_economy_feb.pdf).

Implication: an agent optimizing for interruptions is structurally a dark pattern. Consent, caps and auditability are not niceties — they are the defensible position.

## 8. Metrics

- Notification load: mean **63.5 notifications/day**, 15 users, one week; most viewed "within minutes" (Pielot et al. 2014) [PAPER](https://doi.org/10.1145/2628363.2628364).
- Fragmentation: **57%** of working spheres interrupted before switching; 24 workers (Mark et al. 2005) [PAPER].
- Interruptions/hour, response time and focus time are standard field-study measures, but there is no shared benchmark or normative threshold.
- **"Attention debt" is not a standard metric** — no validated definition found. Define it and label it proprietary.
- No public benchmark for agent attention efficiency; closest are cost-accuracy (VOILA) and VOI-quality (CruxBench) benchmarks.

## 9. Design implications for AMP

**Salience contract:**

```
S(i) = [ EVSI_i · P(accept_i) · exp(−Δt_i / τ_class) ]
       / [ c_tok + c_tool + c_money + c_human ]
c_human = measured resumption cost + opportunity cost of the human's time
```

**Interrupt rule:** interrupt iff `EVSI_i > λ·c_human` AND class budget remains AND not in cooldown AND `habituation_penalty < H_max`. Everything else batches to the next detected breakpoint or digest.

**Priority classes:** P0 safety/legal/irreversible — immediate, bypasses quiet hours, always logged. P1 blocked + deadline inside τ — interrupt within window. P2 decision-relevant but deferrable — batch to breakpoint. P3 FYI — digest only. P4 silent — log, never surface.

**Human attention budget:** a signed manifest declaring per-class caps (e.g., ≤3 P1/day, ≤1 P0/week), quiet hours, max interrupts/hour, per-topic cooldown, expiry and revocation. Consent is a scoped token with a TTL, not a checkbox.

**Ledger, one row per event:** `{ts, class, EVSI_est, c_est, channel, response, resumption_lag, realized_value}`. Derived: attention efficiency = Σ realized value / Σ attention spent; attention debt = Σ age-weighted deferred items; override rate per class (mirrors Ancker's acceptance metric).

**Guardrails:** cap the agent's share of a human's interruptions; require opt-in for the P0 channel; publish the policy in plain language; log refusals as signal.

## 10. Confidence & gaps

- **High:** VOI/EIG formalism; Horvitz ECI framing; batching causality (Fitz RCT); dark-pattern prevalence; AI Act Art. 5 text.
- **Medium:** magnitude of resumption lags (paywalled primaries); generalization from lab to knowledge work.
- **Low / unverified:** 23:15 (unsupported); Hudson et al. (nonexistent); any universal interruption constant; "attention debt" as a measure.
- **Open gaps:** no formal multi-dimensional attention-budget model for agents; no calibrated LLM posterior for EVSI; no benchmark for interruption-policy quality.
