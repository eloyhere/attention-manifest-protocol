# How humans allocate attention — a brief for attention protocols

This is the *descriptive* companion to [attention-economics.md](attention-economics.md). That brief asks what is worth attending to (VOI, EVSI, interruption policy); this one asks how the mechanism that decides is actually built — and therefore where a protocol that models only the normative side will fail.

Labels as elsewhere: [PAPER] [REVIEW] [META] [BOOK] [INDUSTRY]. Where a magnitude sits behind a paywall and could not be confirmed, the direction is quoted and marked. Claims that failed replication are collected in §9 and must not be used as load-bearing evidence.

**One sentence.** Human attention is not a scoring function evaluated afresh each moment; it is a *stateful controller* whose inputs include its own history, its current load, its time on task, and the other minds competing for the same object.

## 1. Three selection drivers, not two

For about twenty-five years the field used a two-way taxonomy: **top-down** (goal-driven) versus **bottom-up** (stimulus-driven, salience). That dichotomy is now regarded as failed *as a taxonomy* [PAPER: Awh, Belopolsky & Theeuwes 2012, *TiCS* 16(8):437–443, [europepmc](https://europepmc.org/article/MED/22795563)].

A third driver is standard: **selection history**. A stimulus acquires or loses priority because of how it was selected before, independently of the current goal and of its current salience [PAPER: Theeuwes 2019, *Current Opinion in Psychology* 29:97–101]. Three mechanisms are well established, and they are *not* the same parameter:

| Mechanism | What changes | Timescale | Canonical evidence |
| --- | --- | --- | --- |
| **Priming** | repeating a target feature speeds selection, no reward required | seconds | [REVIEW] Kristjánsson & Campana 2010, *Attention, Perception, & Psychophysics* 72(1):5–18 |
| **Value-driven capture** | a cue previously paired with reward gains priority and *resists* goal filtering; it survives reversal of the contingency | minutes–days | [PAPER] Anderson, Laurent & Yantis 2011, *PNAS* 108(25):10367–10371, [doi](https://doi.org/10.1073/pnas.1018439108); Anderson & Yantis 2013, *Psych Science* |
| **Inhibition of return** | attention is biased *away* from recently inspected targets | ~0.3–3 s | [PAPER] Posner & Cohen 1984; Klein 2000, *TiCS* 4(4):138–147 |

Inhibition of return matters out of proportion to its timescale, because it is the only one of the three that is *negative*: a mature attentional system carries an explicit mechanism whose whole function is "do not re-inspect that yet". It is the biological precedent for `Frame.ignored[].revisit_if` — and unlike the modern literature on most attentional phenomena, it is old, replicated and unmysterious.

**Engineering consequence.** Salience cannot be a pure function of `(voi, goalFit, uncertainty, novelty, cost, risk, trust)`. The same candidate must score differently depending on what was recently selected, whether it paid off, and whether it was recently rejected. A single `novelty × 0.8` decay is a one-parameter stand-in for at least three mechanisms with different timescales and different signs.

**Caveat, same as for saliency models.** These paradigms are visual and spatial. Transfer to semantic or task content is not established. Use them as a structural prior — the system should *have* a history term — never as a measurement of how much history should matter.

## 2. Capacity is four chunks, and low load is the dangerous case

- **Miller's 7±2 is about chunks under rehearsal.** The limit on un-rehearsed, unrelated items is about **four** [PAPER: Cowan 2001, *BBS* 24(1):87–114, [doi](https://doi.org/10.1017/S0140525X01003922), [PubMed](https://pubmed.ncbi.nlm.nih.gov/11515286/)]. Seven is reachable only by grouping. An agent's focus set is heterogeneous, unrehearsed, and each slot is usually a different *task* — so the achievable figure is nearer four than seven.
- **Load theory's counterintuitive half.** Under *high* perceptual load, distractor processing is reduced because capacity is exhausted. Under *low* load, spare capacity is involuntarily captured by irrelevant stimuli [PAPER: Lavie 1995; Lavie 2005, *TiCS* 9(2):75–82; Lavie 2010, *Current Directions* 19(3):143–148]. **Filtering demand is highest when load is low.** A controller rule that only narrows the focus set as load rises captures half the phenomenon; the residual-capacity regime is exactly where curiosity, novelty and serendipity terms quietly expand a frame that had budget to spare.
- **Capacity is plural.** Multiple-resource theory holds that interference occurs only between tasks sharing a resource dimension (verbal/spatial, perceptual/central, input/output), not between any two tasks that each cost something [PAPER: Wickens 2008, *Human Factors* 50(3):449–455].

**Engineering consequence.** Slot count is the wrong unit — `chunks` is. And the budget vector's dimensions are *costs* (tokens, ms, calls), not *capacities*; no amount of unspent tokens restores a depleted ability to hold distinct task-sets.

## 3. Dwell: the marginal value theorem

Leaving a patch is a separate decision from entering it, and it has a closed-form answer. An optimal forager leaves when the *marginal* capture rate in the current patch falls below the average rate obtainable in the environment, travel time included [PAPER: Charnov 1976, *Theoretical Population Biology* 9(2):129–136]. Applied to information: people follow "information scent" and abandon a page or a source when its marginal yield drops below what a new source promises [PAPER: Pirolli & Card 1999, *Psychological Review* 106(4):643–675; BOOK: Pirolli 2007, *Information Foraging Theory*].

Two predictions that are directly testable in an agent log:

1. **Dwell time rises as the environment gets poorer** (if every other source is bad, staying in this one is correct).
2. **Dwell time rises with re-entry cost.** Organisms systematically *over*-harvest relative to the optimum when travel is expensive, because they act on an estimate of the rate, not the rate.

For an agent, re-entry cost is not travel; it is context reconstruction — the prefix that must be re-read, the handle that must be re-opened, the delegate that must be re-briefed. That cost is large and *known to the host*. A fixed `ttl_turns` ignores it entirely.

## 4. Stopping: a bound, not a threshold on a score

Perceptual decisions terminate when noisy evidence has accumulated to a bound [PAPER: Ratcliff & McKoon 2008, *Neural Computation* 20(4):873–922; Gold & Shadlen 2007, *Annual Review of Neuroscience* 30:535–574]. The speed–accuracy trade-off lives in the **bound**, not in the evidence: urgency and payoff move the bound, and the same stream of evidence therefore terminates earlier or later with the same quality.

Related, and older: search uses **reservation values** derived from search cost rather than full expected-utility maximisation [PAPER: Stigler 1961, *JPE* 69(3):213–225]; satisficing is the general form [PAPER: Simon 1955, *QJE* 69(1):99–118].

**And two error types that must not be conflated.** Signal detection theory separates sensitivity `d'` from criterion `c` [BOOK: Green & Swets 1966]. A fixed abstain threshold `τ` collapses them. A system can decline to answer because it cannot tell (low `d'`) or because it has decided not to answer (high `c`). The two need opposite remedies — better retrieval versus a payoff recalibration — and an instrument that reports one number cannot distinguish them.

## 5. Control itself costs something

The most useful modern framing for a protocol like this one: the brain deploys control in proportion to the **expected value of control** minus the cost of control, where the cost includes the cost of the signal used to recruit it [REVIEW: Shenhav, Botvinick & Cohen 2013, *Neuron* 79(2):217–240, [PubMed](https://pubmed.ncbi.nlm.nih.gov/23889930/)]. People will forgo equal payoffs to avoid cognitive demand [PAPER: Kool, McGuire, Rosen & Botvinick 2010, *JEP: General* 139(4):665–682].

And the meta-level is not free: computing the value of a computation is itself computation [PAPER: Russell & Wefald 1991, *Artificial Intelligence* 49:361–395], which is why resource-rational analysis treats cognitive strategies as optimal under a *resource* constraint rather than a *logic* constraint [PAPER: Lieder & Griffiths 2020, *BBS* 43:e1].

**Engineering consequence.** A controller that runs a full VOI formula over all N candidates has already spent attention deciding what to attend to. Humans do not do this: selection is fast and largely automatic in the common case, and becomes slow and volitional only when the fast path conflicts [REVIEW: Theeuwes 2018, *Journal of Cognition* 1(1); Theeuwes 2019, *Current Opinion in Psychology* 29:97–101]. The architecture analogue is a **cascade**: a cheap screen, then an expensive score on a small survivor set — with the screening cost charged to the budget.

This is the metareasoning version of A-3. The budget currently meters *what the agent looks at*; it does not meter *what the agent spends deciding where to look*.

## 6. Time on task, and what is not time on task

**Vigilance decrement is real and it is effortful.** Sustained attention to low-event-rate signals degrades within tens of minutes, and the decrement is associated with high workload and stress rather than with boredom alone [PAPER: Mackworth 1948; REVIEW: Warm, Parasuraman & Matthews 2008, *Human Factors* 50(3):433–441, [PubMed](https://pubmed.ncbi.nlm.nih.gov/18689050/)].

**It is not ego depletion.** The "willpower is a depleting resource" model failed a 23-laboratory preregistered replication (N = 2,141; effect indistinguishable from zero) [META: Hagger et al. 2016, *Perspectives on Psychological Science* 11(4):546–573]. A protocol may model a *measured* time-on-task curve; it may not import a folk theory of fatigue.

**Switching is its own cost, distinct from interruption.** Task-set reconfiguration costs time and inflates errors [PAPER: Rubinstein, Meyer & Evans 2001, *JEP:HPP* 27(4):763–797; REVIEW: Monsell 2003, *TiCS* 7(3):134–140]. Part of the previous task's goal stays active — "attention residue" [PAPER: Leroy 2009, *OBHDP* 109(2):168–181]. Goals decay during an interruption over seconds [PAPER: Altmann & Trafton 2002, *Cognitive Science* 26(1):39–83], which is the mechanism behind the resumption lags quoted in the economics brief.

**Breaks help, under a condition.** Incubation improves problem solving with a small but reliable meta-analytic effect, and the effect is larger when the interpolated activity is *low*-demand [META: Sio & Ormerod 2009, *Psychological Bulletin* 135(1):94–120]. A break spent on another hard task is not an incubation period.

## 7. Metacognition: two numbers, not one

Confidence and accuracy dissociate, and the standard measures conflate two things. `ECE` mixes calibration *bias* with *resolution* (how well confidence ranks correct above incorrect). `meta-d'` and its ratio to `d'` measure metacognitive efficiency relative to the observer's own sensitivity [PAPER: Maniscalco & Lau 2012, *Consciousness and Cognition* 21(1):422–430; Fleming & Lau 2014, *Frontiers in Human Neuroscience* 8:443].

A system can have excellent `ECE` and no resolution — its confidence curve is flat but well-placed — and a system can have poor `ECE` with good resolution. The load-bearing ceiling rule in §8.4 ("declared confidence may not exceed measured accuracy") is a resolution-flavoured rule expressed in a bias-flavoured statistic.

## 8. Social allocation: attention is spent in front of others

An agent that never shares a human's attention can ignore this section. An agent that delegates, or that asks a person for attention, cannot — because the *social* structure of a group changes what gets attended to, independently of anyone's goals or the salience of the material.

### 8.1 Effort is contingent on identifiability

Individual effort falls as group size rises when contributions cannot be attributed — social loafing [PAPER: Latané, Williams & Harkins 1979, *JPSP* 37(6):822–832]. The moderator is **identifiability**, not group size as such. The same logic produces diffusion of responsibility, where the probability of anyone acting falls as the number of bystanders rises [PAPER: Darley & Latané 1968, *JPSP* 8(4):377–383]. That one is reliable but **not monotonic**: a meta-analysis of 105 studies gives a small-to-moderate effect (g ≈ −0.35) that weakens, and can reverse, in dangerous emergencies [META: Fischer et al. 2011, *Psychological Bulletin* 137(4):517–537].

**Implication.** A `blocking` unknown owned by "the team" is owned by no one. Per-agent contribution must be identifiable in the merged ledger, or the merge will systematically under-retrieve.

### 8.2 Groups discuss what everyone already knows

The most robust finding in group decision research: discussion is biased toward **shared** information and away from **unique** information, so groups often fail to discover the solution that any single member could have produced alone — the hidden profile [PAPER: Stasser & Titus 1985, *JPSP* 48(6):1467–1478]. Two mechanisms: a *sampling advantage* (an item known to four members has four chances to be mentioned) and *social validation* (repeating something already said is rewarded; introducing something new is not). Meta-analytically this holds: across 65 studies and 101 effects, shared information is mentioned far more than unique information, and groups with a hidden profile are roughly **eight times** less likely to reach the correct solution than groups whose profile is fully shared [META: Lu, Yuan & McLeod 2012, *Personality and Social Psychology Review* 16(1):54–75]. The factor of eight is relative to a full-information group, not a base rate; the absolute solve rate depends on the design.

What reduces it: assigning distinct expertise/roles, explicitly soliciting each member's unique items, and polling **before** consensus forms. What does not: exhorting the group to "consider all information".

**Implication.** "Each delegate is competent" does not compose into "the team is competent". Merge must ask for unique items *first*, and treat a delegate with nothing unique as a signal about the delegation, not about the delegate.

### 8.3 The directory, not the members, is the fragile part

Transactive memory: groups encode *who knows what* as a directory, and group performance depends on the directory's accuracy as much as on members' knowledge [BOOK: Wegner 1987, in *Theories of Group Behavior*; PAPER: Lewis 2003, *Journal of Applied Psychology* 88(4):587–604]. The documented failure mode is membership change — the directory goes stale, and the group behaves as if knowledge that left is still present [REVIEW: Ren & Argote 2011, *Academy of Management Annals* 5(1):189–229].

**Implication.** A directory must be invalidated on membership change, not merely updated. An agent that has left must not remain credited with having looked at something.

### 8.4 Cascades and conformity

Under a unanimous wrong majority, accuracy drops substantially; a single dissenting ally restores much of it [PAPER: Asch 1951/1956]. Informational cascades make this rational rather than weak: once enough public signals accumulate, ignoring one's own private signal is the better bet [PAPER: Bikhchandani, Hirshleifer & Welch 1992, *JPE* 100(5):992–1026].

**Implication.** A team protocol needs a *protected* dissent budget and an auditable contribution **order**. If the first two agents agree, the third's agreement carries almost no information, and the merge must not weight it as if it did.

### 8.5 Accountability cuts both ways

Being accountable to an audience whose views are **unknown** produces more integratively complex, self-critical reasoning — people pre-empt objections. Being accountable to an audience with a **known** view produces defensiveness and confirmation [REVIEW: Lerner & Tetlock 1999, *Psychological Bulletin* 125(2):255–275].

**Implication.** Requiring justification is useful only when the justifier cannot infer what the judge wants. Publishing the decision rule *before* the outcome is the operational form; asking an agent to justify itself to a checker that shares its priors is theatre.

### 8.6 Common ground is a process, not a state

Grounding is collaborative and costly, and repeated reference to the same object becomes cheaper over turns — entrainment [PAPER: Clark & Wilkes-Gibbs 1986, *Cognitive Science*; Clark & Brennan 1991]. This yields a falsifiable prediction for a protocol: the cost of re-establishing the same `CommonGround` should *fall* across a session. If it does not, the grounding is being re-derived rather than reused.

### 8.7 Collective attention has its own decay

Attention to a topic at population scale decays, and the decay has accelerated over successive years: the tenure of a top-50 hashtag on Twitter fell from about **17.5 hours in 2013 to 11.9 hours in 2016** [PAPER: Lorenz-Spreen, Mønsted, Hövel & Lehmann 2019, *Nature Communications* 10:1759, [doi](https://doi.org/10.1038/s41467-019-09311-w)]. One platform, one metric, one period — read it as a demonstration that the decay itself moves, not as a constant to hard-code.

**Implication.** A concept's `ttl` should be calibrated against the observed decay in its own domain, not fixed globally.

### 8.8 Asking costs the asker too

The interruption literature prices the *receiver's* attention. Humans also pay to ask — obligation, face threat, the risk of appearing incompetent — which is why people systematically *under*-ask for help. Agents have none of those costs, so the analogous bias runs the other way: they over-ask. The fix is not to give an agent social anxiety; it is to price the ask symmetrically, which the `interrupts` dimension already half does.

### 8.9 What this implies for a machine protocol

| # | Finding | Structural requirement |
| --- | --- | --- |
| 1 | Identifiability moderates effort | per-agent contribution must be visible in the merged ledger |
| 2 | Shared-information bias | merge must poll unique items **before** aggregation; `nothing_unique` is a recorded signal |
| 3 | Transactive memory | an explicit attention directory, invalidated on membership change |
| 4 | Cascades | protected dissent budget + contribution order recorded |
| 5 | Accountability asymmetry | publish the rule before the outcome; do not "justify" to a like-minded checker |
| 6 | Entrainment | re-grounding the same proposition should get cheaper; if not, common ground is being rebuilt |
| 7 | Topic decay | concept TTL calibrated per domain from measured decay |

Note what is *not* on this list: no theory of mind, no emotional modelling, no "team chemistry". Each item is a bookkeeping requirement that can be tested against a log, which is the only kind of social claim a protocol can enforce.

## 9. Myth hygiene (do not cite)

| Claim | Status |
| --- | --- |
| "Human attention span is 8 seconds; goldfish, 9" | **No primary source.** Traces to a 2015 Microsoft Canada marketing report and aggregator pages; not a peer-reviewed measurement, and not measurable as stated. Same class of artefact as the 23-minute claim already listed in [README.md](README.md). |
| "It takes 23 minutes to refocus after interruption" | **Unsupported**; see [attention-economics.md](attention-economics.md) §4 and [README.md](README.md). |
| "Willpower depletes like a battery" | **Failed replication**, 23 labs, N=2,141 [Hagger et al. 2016]. |
| "Working memory holds 7±2 items" | **Miscited.** Miller's 7 is chunks with rehearsal; unrehearsed capacity is ~4 [Cowan 2001]. |
| "Attention is a spotlight" | **Misleading metaphor.** It implies one resource and predicts interference between any two tasks; multiple-resource evidence says interference is dimension-specific [Wickens 2008]. |
| "Arousal and performance follow an inverted U" | **Overgeneralised.** Yerkes–Dodson (1908) is a rodent law; the human curve is not a reliable quantitative relation and is routinely used to license arbitrary claims. |
| "Brain-training games raise general attention" | **Not supported.** Far transfer is not established; near transfer is task-specific. |
| "Brainstorming groups are more creative than the same people working alone" | **False as stated.** Interacting groups produce fewer and worse ideas than nominal groups [Diehl & Stroebe 1987, *JPSP* 53(3):497–509]; production blocking as the mechanism is confirmed in Diehl & Stroebe 1991, *JPSP* 61(3):392–403. The often-quoted "two-to-one" size of the advantage is not confirmed. |
| "The mere presence of others improves performance (social facilitation)" | **Conditional, and the simple version failed replication.** A preregistered replication of Zajonc's classic design found inhibition only, with no facilitation [Halfmann et al. 2020, *Psychological Science*]; the older meta-analysis already showed the effect depends on task type and evaluation [Bond & Titus 1983, *Psychological Bulletin* 94(2):265–292]. |

Two positive rules follow, and they are the same rules the economics brief already used:

1. **Prefer the direction of a well-replicated effect to the magnitude of a single study.**
2. **Prefer a measured curve over a folk theory.** If an implementation wants a fatigue term, a habituation constant or an interruption price, the number must come from its own receipts, and be labelled as such.

## 10. What this implies for a machine attention protocol

Ten mechanisms, each with a probe that can fail:

| # | Mechanism | Probe: an implementation that ignores it will… | Where it lands |
| --- | --- | --- | --- |
| 1 | Selection history (priming, value, IOR) | re-rank every cycle from scratch; never learn that a source class is worthless | `salience` input |
| 2 | Inhibition of return | show items that were rejected three cycles ago as if newly discovered | `ignored` |
| 3 | Capacity in chunks, not slots | hold 7 heterogeneous targets and pick worse than with 4 | focus cap |
| 4 | Low load invites capture | fill spare budget with novelty when the task is easy | policy |
| 5 | Marginal value / patch leaving | keep reading a source that stopped paying; or abandon one it should over-harvest | dwell / `ttl_turns` |
| 6 | Evidence accumulation to a bound | oscillate between two candidates without ever terminating | impasse |
| 7 | `d'` vs criterion | report one accuracy number and never separate "cannot tell" from "chose not to say" | calibration |
| 8 | Cost of control | spend more attention choosing than doing | budget |
| 9 | Time on task | degrade silently in long runs, with no recorded cause | modes / `rest` |
| 10 | Social allocation | let N agents duplicate retrieval and miss the one unique source | team / merge |

The concrete protocol changes are in [attention-upgrade.md](../attention-upgrade.md); the invariant numbering there continues from [`docs/architecture.md`](../architecture.md) §3.8.
