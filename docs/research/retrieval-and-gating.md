# AMP Retriever & Gating Policy — Evidence Brief

Provenance: [PAPER] peer-reviewed/preprint · [VENDOR] vendor doc/blog · [SPEC] standards body · [SIMULATION] synthetic/projected · [UNVERIFIED] could not confirm.

## 1. Tool Attention: verified mechanism & numbers

**Exists — confirmed [PAPER].** arXiv:2604.21816, "Tool Attention Is All You Need: Dynamic Tool Gating and Lazy Schema Loading for Eliminating the MCP/Tools Tax in Scalable Agentic Workflows," **Anuj Sadani & Deepak Kumar** (Infrrd.ai), submitted 23 Apr 2026, **v1 only**, 21 pp, CC BY 4.0, code `github.com/asadani/tool-attention` ([abs](https://arxiv.org/abs/2604.21816)). OpenAlex [W7155548032](https://openalex.org/W7155548032) shows **0 citations** (Sep 2026 snapshot): unreviewed, uncited.

**ISO score.** Cosine similarity between query embedding and a precomputed per-tool *summary* embedding ([§4.2](https://arxiv.org/html/2604.21816v1)): `ISO(q,tᵢ) = e_qᵀe_tᵢ / (‖e_q‖‖e_tᵢ‖)`. Encoder **all-MiniLM-L6-v2, d=384**; summary `sᵢ` = name + shortened natural-language description, target ≤60 tokens; `e_tᵢ` precomputed offline.

**State gating.** `g(tᵢ;q,state_t) = 1[ISO(q,tᵢ) ≥ θ] · 1[state_t ⊨ preᵢ]`; preconditions like `requires_auth`, `only_after_search`. Active set `A_t = top-k{tᵢ : g=1}` ranked by ISO. It is a **hard multiplicative filter, not a soft prior**. Cross-turn state-aware gating is deferred to future work (§8), so implemented state is shallow.

**Two-stage lazy load.** Compact summary pool stays in context; full JSON schemas are promoted only for top-k gated tools. Reference impl: LangGraph middleware + FAISS + sentence-transformers + tiktoken, hooked into `before_model` / `modify_model_request`.

**The numbers are simulation-measured, not agent-measured.** 47.3k→2.4k per-turn tool tokens (−95.0%) and 24%→91% "effective context utilization" are measured **in a simulated 120-tool, six-server benchmark** whose per-server token counts are calibrated to public audits. The abstract is explicit: task success, latency, cost and reasoning quality "are reported as *projections* … they are **not measured on live LLM agents**." Arithmetic is self-consistent (2.4/47.3 = 5.1%; 91/24 = 3.8×, matching the claimed 3.8×).

**The gap that matters for AMP:** the paper reports **no retrieval metric at all** — no recall@k, nDCG, or selection accuracy in the abstract, contributions, or §4.2 (my full-text retrieval truncated at §4.2; §5.2 "Encoder choice and threshold calibration" holds θ/top-k defaults — **[UNVERIFIED]**). Its dependent variable is *tokens*. At 120 tools with top-k≈5, recall is near-saturated, so it **cannot** be cited as evidence retrieval works at 1,000+. Its "~70% context-utilization fracture point" rests on practitioner blogs, not peer review.

⚠️ It chose **MiniLM-L6 — the worst dense retriever** on the only dedicated tool-retrieval benchmark (§2).

## 2. Retrieval benchmarks & recall numbers

**ToolRet** [PAPER] ([Shi et al., ACL 2025](https://arxiv.org/abs/2503.01763)): 7,615 tasks, **43,215 tools**; avg query 46.9 tok, avg tool doc 174.6 tok, 2.17 targets/query. Query↔target ROUGE-L is only **0.06** (vs 0.31 NQ, 0.34 MSMARCO) — low lexical overlap, so dense *should* win, yet "even NV-embed-v1 achieves nDCG@10 of only 33.83."

| Corpus / system | nDCG@10 | R@10 | Note |
|---|---|---|---|
| ToolRet · BM25s | 22.3 | 28.4 | sparse baseline |
| ToolRet · **all-MiniLM-L6-v2** | **16.3** | **21.7** | **Tool Attention's encoder — worst** |
| ToolRet · bge-large-en-v1.5 | 23.0 | 30.3 | |
| ToolRet · GritLM-7B | 30.0 | 38.0 | |
| ToolRet · NV-Embed-v1 | 33.8 | 41.8 | best bi-encoder |
| ToolRet · jina-reranker-v2-base | 33.6 | 42.0 | as first-stage scorer |
| ToolRet · bge-reranker-v2-gemma | **35.5** | **44.5** | best in table |
| ToolRet (Tool-DE protocol) · BM25s | 36.4 | 46.4 | ⚠️ same BM25, +64% vs above |
| ToolRet (Tool-DE protocol) · Qwen3-Emb-8B | 46.2 | 57.5 | |
| Tool-DE · Tool-Embed/Tool-Rank | 56.4 | 67.8 | **on Tool-DE, not ToolRet** |

Sources: ToolRet table ([ar5iv](https://ar5iv.labs.arxiv.org/html/2503.01763)); Tool-DE rerun ([Lu et al. 2025](https://arxiv.org/html/2510.22670v1)).

⚠️ **Cross-paper comparability is broken**: BM25s R@10 on the *same* benchmark is 28.4 vs 46.4 depending on protocol (instructional setting, macro- vs micro-averaging). Never compare absolute recall across papers; re-run in-house.

**Shortlist coverage vs registry size** — the best quantitative anchor for "recall is the ceiling" [PAPER] ([Repantis et al. 2026](https://arxiv.org/abs/2605.24660)), registries 20→3,251 tools:
- **BFCL, 370 tools**: adaptive policy averaging **7** tools ≈ coverage of showing **50** (90.3% vs 90.8%).
- **ToolBench, 3,251 tools**: fixed **top-5 covers only 64.7%** aggregate; retrieves **nothing** when the correct tool ranks 6th–20th; adaptive depth recovers 16.7% there.
- **Downstream selection** (Claude Sonnet 4.6): adaptive lists 93.1% vs 87.1% (always-5); **76.8% vs 60.9%** on medium-difficulty queries where the correct tool is present but not ranked first.

⇒ At ~3k tools, **top-5 leaves ~35% of tasks unreachable**. This is the strongest published support for your premise.

**Scaling 100→1k→10k: no clean recall curve exists. [UNVERIFIED/gap]** Closest is [LongFuncEval](https://arxiv.org/abs/2505.10570) [PAPER] (IBM): "**7% to 85% performance drop as the number of tools increases**" — but that varies *in-context* tool count, not retrieved-shortlist size. MetaTool [PAPER] ([ICLR'24](https://openreview.net/attachment?id=R0c2qtalgG&name=pdf)) frames selection as two decisions (whether / which) over ~199 tools; its ToolE subsets underpin the Toolshed results below.

## 3. Reranking evidence

- **Reranker-as-scorer beats bi-encoders, modestly, on ToolRet** [PAPER]: bge-reranker-v2-gemma 35.5 nDCG / 44.5 R@10 vs NV-Embed-v1 33.8 / 41.8 → **+1.7 nDCG, +2.7 R@10**. Real but not transformative.
- **Trained rerankers are where larger gains live** [PAPER]: [Tool-DE](https://arxiv.org/html/2510.22670v1) trains Tool-Rank (Qwen3-Reranker-4B, LoRA r=32, 200k pairs) on top of the best first stage and reports SOTA on Tool-DE (56.4 nDCG@10 / 67.8 R@10), +10.2 nDCG over the MTEB SOTA open embedder.
- **Bundled RAG stack, big absolute gains** [PAPER]: [Toolshed / Advanced RAG-Tool Fusion](https://arxiv.org/abs/2410.14594) reports **+46%, +56%, +47% absolute Recall@5** on ToolE single-tool, ToolE multi-tool, Seal-Tools — but bundles pre-retrieval doc enhancement, query planning, and post-retrieval refinement, so the reranker's own contribution is **not attributable**.
- **Latency: no published tool-specific number. [UNVERIFIED]** No paper I found reports reranker ms/query for tool selection. Budget it yourself; a cross-encoder over 50–100 candidates is tens of ms on GPU, hundreds on CPU.
- **Query expansion / HyDE**: Tool-DE's evidence favors **offline document expansion over online query expansion** — expansion is query-independent, cached, and adds no per-turn generation round-trip. Related: Re-Invoke (pseudo-query augmentation), EASYTOOL (doc restructuring), ScaleMCP (segment weighting), MassTool (multi-task detect+retrieve), all cited in [Tool-DE §5](https://arxiv.org/html/2510.22670v1). No tool-specific HyDE win is published.

## 4. Model selection limits (tool count vs accuracy)

- **Monotone degradation, no proven cliff** [PAPER]: [LongFuncEval](https://arxiv.org/abs/2505.10570) — 7%–85% drop as tool count grows; 7%–91% as tool *response* length grows; 13%–40% over longer multi-turn. ⚠️ The widely repeated "**30–50 tool threshold**" is **folklore — [UNVERIFIED]**. No credible source establishes a sharp cliff.
- **Anthropic Tool Search Tool** [VENDOR] ([announcement](https://www.anthropic.com/research/advanced-tool-use)): internal MCP evals, **Opus 4 49% → 74%**, **Opus 4.5 79.5% → 88.1%**. Token story: 58 tools ≈ 55K tokens; GitHub 35 tools ≈ 26K; Jira alone ≈17K; seen **134K** before optimization; **~77K → ~8.7K** with search (they say "85% reduction"; 77→8.7 is 88.7% — minor internal inconsistency). Internal, unaudited.
- **Near-duplicate names are a named failure mode** [VENDOR]: "the most common failures are wrong tool selection and incorrect parameters, especially when tools have similar names like `notification-send-user` vs `notification-send-channel`." Direct support for your ambiguity concern.
- **Anthropic's own threshold is token-based, not count-based** [VENDOR]: use when definitions exceed **>10K tokens** or you have **10+ tools**; *not* beneficial below 10 tools.
- Caveat on "fewer = better": Anthropic's gain conflates fewer candidates with a search step and a different prompt shape. The cleanest controlled evidence remains 2605.24660's downstream 76.8% vs 60.9%.

## 5. Abstention evidence

- **When2Call** [PAPER] ([NAACL 2025](https://aclanthology.org/2025.naacl-long.174/)): 3-way decision — call / ask follow-up / admit unanswerable. "State-of-the-art tool-calling LMs show significant room for improvement"; preference optimization beats plain fine-tuning.
- **Constrained decoding destroys abstention — quantified** [PAPER] ([Lee 2026](https://arxiv.org/abs/2608.13959)): a grammar over tool names is **negative on abstention accuracy in 4 of 6 cells with intervals excluding zero, positive in none, worst case −29.5 points**. Of 698 abstentions it "repaired," 545 had no readable answer at all and **0 were correct decisions the scoring rule rejected**. ⇒ **Do not force AMP's model into a tool-name grammar; keep "no match" a first-class emission.**
- **BFCL** [PAPER] scores an **irrelevance-detection** category alongside AST accuracy — use it as an external abstention probe.
- **Gap [UNVERIFIED]**: no published calibrated-abstention-vs-FP-rate curve for *tool retrieval*. You must calibrate τ yourself on labelled misses.

## 6. Gating signals & conflict handling

- **Only published semantic + hard-filter formulation**: Tool Attention's `1[ISO≥θ]·1[state⊨pre]` (§1) — the gating is exactly your eligibility idea, but shallow (per-turn, no cross-turn state).
- **Permission substrate** [SPEC]: [MCP authorization](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization) is **OPTIONAL, transport-level, OAuth 2.1**, with audience-bound tokens (RFC 8707) and an explicit "Access Token Privilege Restriction" (least-privilege) section. **Scopes are the natural eligibility key.**
- **ACL-trimmed retrieval ships in production search** [VENDOR]: Azure AI Search's SharePoint indexer ingests **permission metadata (ACLs)** so results are trimmed per identity ([docs](https://learn.microsoft.com/id-id/azure/search/search-indexer-sharepoint-access-control-lists)). Research variants: key-parameterised embeddings for RAG access control ([IEEE](https://ieeexplore.ieee.org/document/11645326)); role-based vector filtering ([Zenodo](https://zenodo.org/records/15717386)).
- **Cost / latency / health / rate-limit as gates [UNVERIFIED]**: no published system combines these with semantic retrieval. Design inference, not evidence.
- **Conflict handling — no published protocol.** My recommendation: apply **hard** filters (permission, tenant, feature flag, hard-down) *before* ranking, but return `blocked_by: ["scope:repo:write"]` on near-miss tools so the agent can request step-up instead of silently losing recall. **Soft** signals (cost, p95 latency, rate-limit headroom) should multiply the score *after* ranking, never filter — otherwise a slow tool becomes invisible and unrecoverable. Rationale: pre-filtering makes recall loss *invisible* in logs, which is the worst failure mode for a system whose ceiling is recall.

## 7. Catalog representation

- **Docs are the bottleneck, not the encoder** [PAPER] ([Tool-DE](https://arxiv.org/html/2510.22670v1)): auditing 300 sampled ToolRet docs, **41.6% lacked a clear functional statement or actionable usage guidance**; up to **7 phrasings for the same function** across sources.
- **Field-level findings**: expansion pipeline adds `function_description`, `tags`, `when_to_use`, `limitations`, `example_usage`. Original doc 131.7 tok → +45.9 profile tok (**+35%**). Ablation shows **removing `when_to_use` *improves* performance**, and `example_usage` is dropped; retained set = `function_description` + `when_to_use` + `limitations` + `tags`. ⇒ **Structured generated fields (tags, limitations) beat verbose naming; "when to use" framing helps.**
- Exact per-field deltas are in [§4.1](https://arxiv.org/html/2510.22670v1) but were **truncated in retrieval — [UNVERIFIED]**.
- **Namespacing precedent** [VENDOR]: Anthropic uses dotted `server.tool` (`github.createPullRequest`) and can defer **whole servers** via `mcp_toolset` + `default_config.defer_loading`, keeping high-use tools (`search_files`) eager. Strong precedent for AMP's server/tool namespacing with per-server deferral.
- **Versioning** [UNVERIFIED/gap]: no published evidence on retrieval stability across schema versions. Recommend: embed a **version-stable** summary; keep version/`schema_hash` out of the embedded text and only in the expanded schema.

## 8. Metrics & telemetry

- **Metric set** [PAPER]: nDCG@K, Recall@K, and **Completeness@K** (C@K = 1 iff *all* targets in top-K) — Completeness is the right primary metric for multi-tool tasks ([Tool-DE §3.1](https://arxiv.org/html/2510.22670v1)).
- **Chance correction** [PAPER]: **Bits-over-Random (BoR)** normalizes for the fact that larger k trivially includes more ([2605.24660](https://arxiv.org/abs/2605.24660)) — use it to justify k rather than raw recall@k, which is monotonically inflatable.
- **Miss→failure attribution** [PAPER]: ToolRet's Fig. 1 links retriever R@10 to end-to-end pass rate (correlational; exact r **not verified**). Instrument three exclusive buckets: (a) **not-retrieved** = recall miss; (b) **retrieved-not-chosen** = selection miss; (c) **chosen-bad-args** = schema/param error. Anthropic claims (b)+(c) dominate over (a) [VENDOR] — if true for you, your ceiling is *selection*, not recall, and expanding k won't help.
- **Telemetry schema** [SPEC]: OTel semantic conventions v1.44.0 ship dedicated **Gen AI** and **MCP** attribute registries plus `execute_tool` span semantics ([Gen AI](https://opentelemetry.io/docs/specs/semconv/registry/attributes/gen-ai/), [MCP](https://opentelemetry.io/docs/specs/semconv/registry/attributes/mcp/)). ⚠️ Exact attribute names **not verified** (pages truncated behind nav). Hang AMP-specific fields (`amp.query_id`, `amp.k`, `amp.scores[]`, `amp.blocked_by[]`, `amp.abstained`) as a namespaced extension alongside them.
- No published tool-selection telemetry schema exists beyond OTel's generic conventions. **[UNVERIFIED/gap]**

## 9. Design implications for AMP's Retriever

**Offline.** Enrich each tool into a 60–120 tok summary: `name` + `function_description` + `tags` + `when_to_use` + `limitations` (§7). Embed with a **tool-tuned embedder** — Qwen3-Embedding-0.6B/4B-class or Tool-Embed. **Do not use MiniLM-L6**: worst on ToolRet (16.3 nDCG / 21.7 R@10, below BM25).

**Per call — 5 stages.**
1. **Hybrid first stage**: BM25 (catches exact names/synonyms/product nouns — users say "jira", "PR") ⊕ dense; fuse with **RRF** (k=60). Both are cheap and complementary; BM25 is what Anthropic ships by default.
2. **Hard eligibility filter** applied *before* ranking: permission scope, tenant, feature flag, hard-down health. Attach `blocked_by` and surface near-miss blocked tools as `requires_auth` affordances rather than deleting them (§6).
3. **Rerank top-50 → top-k** with a cross-encoder/LLM reranker (Tool-Rank-class). Worth paying: +1.7 nDCG on ToolRet, more with a trained reranker. Measure ms p95 yourself — no published number exists.
4. **Return k = 8–12, adaptively.** Do not use k=5: at 3.2k tools top-5 covers 64.7% and finds *nothing* when the truth ranks 6–20. Adaptive depth (avg ~7) matched fixed-50 coverage on BFCL. Widen k when the score gap between rank-k and rank-k+1 is small.
5. **Abstain explicitly.** If fused top-1 < τ (calibrated on labelled misses to a target FP rate), return `no_match` + 3 nearest as *suggestions only*. Never grammar-constrain to tool names (−29.5 pts abstention, §5).

**inspect_tool.** Expand full schema only for the chosen id; keep the summary pool cacheable in the system prompt (this is exactly `defer_loading` / two-phase loading). Defer at **server granularity** where a server is cold.

**Failure handling.** On empty/ambiguous results: rewrite the query from rolling conversation context and re-retrieve once (log both passes). On `blocked_by`: request step-up auth, don't fall through to a worse tool. On abstain: tell the model what *categories* exist so it can rephrase — abstention should be informative, not terminal.

## 10. Confidence & gaps

**High confidence** [PAPER/VENDOR]: Tool Attention exists, is by Sadani & Kumar, and its 95%/24→91% figures are **simulation-measured with projections clearly labelled**; ToolRet numbers incl. MiniLM being worst; Anthropic's 49→74 / 79.5→88.1 and near-duplicate-name failure mode; LongFuncEval 7–85%; constrained decoding costing abstention.

**Medium** [PAPER]: reranker ROI magnitude; Toolshed's +46/+56/+47 (bundled stack, weak baseline; not reranker-attributable); 2605.24660's coverage numbers (single unreviewed preprint).

**Low / unverified**: Tool Attention's θ and top-k defaults (§5.2 truncated); any cross-paper absolute recall comparison; reranker latency; the "30–50 tool threshold"; Tool-DE per-field ablation deltas; OTel exact attribute names; retrieval stability under versioning.

**Biggest gap for AMP**: *no published recall-vs-catalog-size curve exists (100→1k→10k)*, and no calibrated abstention curve for tool retrieval. Both are cheap to measure in-house and are the two numbers that will actually determine AMP's ceiling. Build the synthetic upscale harness (real query logs × replicated/perturbed catalog) before tuning the reranker.
