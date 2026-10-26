# AMP grounding brief: deferred tool loading + prompt caching on frontier APIs

Research date 2026-10-24. [VENDOR] = first-party model/cloud doc; [INDEPENDENT] = third-party docs/proxies; [UNVERIFIED] = no first-party confirmation (Anthropic's `platform.claude.com` host redirects to `anthropic.com` for this fetcher; field detail below comes from the vendor research post, reachable mirrors, cross-checks).

## 1. Tool Search Tool: mechanism + exact fields

- Two server-executed variants: `tool_search_tool_regex_20251119` (model emits `input.pattern`, case-insensitive Python-regex style) and `tool_search_tool_bm25_20251119` (`input.query`, natural language). Undated aliases resolve to the dated ones. Declared as `{"type":"tool_search_tool_regex_20251119","name":"tool_search_tool_regex"}` — verbatim in [VENDOR] ([advanced tool use](https://www.anthropic.com/research/advanced-tool-use)).
- Deferral is per tool: `"defer_loading": true`. Deferred definitions must still be **sent on every request** (server-side expansion needs them) but are not rendered into context. At least one tool must stay non-deferred (else 400). A deferred tool cannot also carry `cache_control` (400). [INDEPENDENT: [wire reference](https://raw.githubusercontent.com/xmiksay/entanglement/refs/heads/master/scratch/tool-search-wire-reference.md)]
- MCP: `{"type":"mcp_toolset","mcp_server_name":"google-drive","default_config":{"defer_loading":true},"configs":{"search_files":{"defer_loading":false}}}` — `default_config` defers the server, `configs` re-enables hot tools. [VENDOR]
- Input: pattern (regex ≤200 chars) or query (BM25 ≤500 chars), plus optional `limit` (default 5). Search matches tool names, descriptions, argument names and descriptions. [INDEPENDENT]
- Output: `server_tool_use` (`srvtoolu_…`) → `tool_search_tool_result` holding `tool_references:[{"type":"tool_reference","tool_name":"get_weather"}]`. The API expands references into full definitions inline; never return a `tool_result` for the `srvtoolu_` id; empty match = empty array; failures arrive as HTTP 200 with `error_code` (`invalid_tool_input`, `unavailable`, `too_many_requests`, `execution_time_exceeded`). Custom search is allowed: return `tool_reference` blocks in an ordinary `tool_result`. [INDEPENDENT]
- **Caps**: catalog max **10,000 tools**; "returns up to five most relevant tools per search by default" — [VENDOR] [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/tool-search). So "≤5" is a **default result count, not a per-turn load cap**; multiple searches per turn are allowed and `limit` can be raised (reported ceiling 10,000, [INDEPENDENT]).
- **Cache interaction** (the design-critical fact): "Tool Search Tool doesn't break prompt caching because deferred tools are excluded from the initial prompt entirely… your system prompt and core tool definitions remain cacheable." [VENDOR] [INDEPENDENT] adds: deferred tools are stripped from the rendered tools section *before the cache key is computed*; expansion is spliced into the message body.

## 2. Numbers table

| Claim | Value | Provenance | URL |
|---|---|---|---|
| Tool defs, 50+ MCP tools: upfront → TST | ~72K → ~8.7K tok (−85%) | [VENDOR] | [link](https://www.anthropic.com/research/advanced-tool-use) |
| 5-server MCP setup (58 tools) | ≈55K tokens | [VENDOR] | same |
| Worst internal overhead / context preserved | 134K tokens; 191,300 vs 122,800 tok | [VENDOR] | same |
| TST cost / loaded tools | ~500 tok; 3–5 tools ≈3K tok | [VENDOR] | same |
| Opus 4 selection accuracy | 49% → 74% | [VENDOR] | same |
| Opus 4.5 selection accuracy | 79.5% → 88.1% | [VENDOR] | same |
| PTC average tokens | 43,588 → 27,297 (−37%) | [VENDOR] | same |
| PTC accuracy | knowledge retrieval 25.6%→28.5%; GAIA 46.5%→51.2% (post says "GIA", link → [GAIA](https://arxiv.org/abs/2311.12983)) | [VENDOR] | same |
| `input_examples` accuracy | 72% → 90% | [VENDOR] | same |
| Code exec with MCP | 150,000 → 2,000 tok (−98.7%) | [VENDOR] | [link](https://www.anthropic.com/research/code-execution-with-mcp) |
| Degradation threshold | ">30–50 tools loaded at once" | [VENDOR] | [link](https://code.claude.com/docs/en/agent-sdk/tool-search) |
| Claude cache write/read; min prefix | 1.25× (5 min), 2× (1 h) write; 0.1× read; ≤4 breakpoints. Min prefix: 1,024 (Opus 4/4.8, Sonnet 4.5/4.6/5); 2,048 (Opus 4.7, Haiku 3.5); 4,096 (Opus 4.5/4.6, Haiku 4.5); 512 (Opus 5, Sonnet 5.5, Haiku 5.5) | [INDEPENDENT] | [OpenRouter](https://openrouter.ai/docs/guides/best-practices/prompt-caching) |
| OpenAI prefix | 1,024 tok min, first 1,024 identical; 128-tok increments ≤GPT-5.5 | [VENDOR] | [Microsoft](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/prompt-caching) |
| OpenAI write/read (5.6+) | write 1.25×; read 0.25×/0.5× | [INDEPENDENT] | [OpenRouter](https://openrouter.ai/docs/guides/best-practices/prompt-caching) |
| Gemini implicit caching | read 0.25×; min 1,024 (Flash)/4,096 (Pro); TTL ~3–5 min | [INDEPENDENT] | same |
| Tool-result cap | 25,000 tokens (Claude Code default) | [VENDOR] | [link](https://www.anthropic.com/research/writing-tools-for-agents) |

The 49→74 / 79.5→88.1 benchmark is **Anthropic's internal, unnamed MCP tool-selection evaluation**; the numbers are as claimed but vendor-reported and not publicly reproducible.

## 3. Programmatic Tool Calling

- Opt-in per tool: `"allowed_callers": ["code_execution_20250825"]`, plus `{"type":"code_execution_20250825","name":"code_execution"}`. "The API converts these tool definitions into Python functions." [VENDOR]
- Flow: Claude emits `server_tool_use` (`code_execution`, `input.code`); each in-code call reaches you as `tool_use` with `caller:{"type":"code_execution_20250825","tool_id":"srvtoolu_…"}`; your result goes to the sandbox, not the model; only the final `code_execution_tool_result` (`content.stdout`) enters context. Environment: "the Code Execution tool (a sandboxed environment)"; the script pauses for results, resumes, supports `asyncio.gather`. [VENDOR]
- Reported: 43,588 → 27,297 tok (−37%); 200 KB raw expense data → ~1 KB results; knowledge retrieval 25.6→28.5; GAIA 46.5→51.2. [VENDOR]
- **Errors/large outputs**: only `stdout` is documented as returning. How tool errors reach the script, `stderr` capture, and in-sandbox truncation are unstated in reachable sources — [UNVERIFIED]; live-test before designing to assumed semantics.

## 4. Tool Use Examples

`input_examples` is an array of literal example *inputs* on a tool definition, teaching format conventions (dates, `USR-12345` ID shapes), nested-object construction, and optional-parameter correlations that JSON Schema cannot express. Reported 72% → 90% on complex parameter handling; costs tokens; expands together with a deferred tool's definition when discovered. [VENDOR]; expansion detail [INDEPENDENT].

## 5. Prompt caching mechanics and invalidation (critical)

**Claude.** Explicit `cache_control:{"type":"ephemeral"}` on a block, optional `"ttl":"1h"` (default 5 min, refreshed on each hit), max 4 breakpoints, write 1.25×/2×, read 0.1×, model-specific minimum prefix (table). [INDEPENDENT] + [AWS Bedrock](https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html).

**The invalidation rule**, verbatim from AWS's Bedrock guide for Claude: *"Cache checkpoints are processed in this order: `tools` → `system` → `messages`. The minimum cache size is evaluated against the cumulative tokens across all three sections… Because the sections are chained, changing content in an earlier section invalidates the cache for later sections (for example, modifying `tools` invalidates the `system` and `messages` caches)."* And: *"Prompt prefixes should remain static between requests. Changes to a prompt prefix in subsequent requests result in cache misses."* [VENDOR: AWS]

So **yes** — editing a tool definition, inserting/removing a tool before others, or reordering `tools` changes the serialized prefix and invalidates everything downstream. Tools serialize in supplied order; there is no canonical sort. Deferred tools are the escape hatch: excluded from the initial prompt [VENDOR], stripped before the cache key [INDEPENDENT].

**OpenAI.** Automatic prefix caching: ≥1,024 tokens and "the first 1,024 tokens in the prompt must be identical"; "a single character difference in the first 1,024 tokens results in a cache miss"; hits round to 128-token increments on ≤GPT-5.5; `prompt_cache_key` improves matching; cached content includes "both the messages array and tool definitions". GPT-5.6+ adds `prompt_cache_breakpoint`, `prompt_cache_options.mode` (`implicit`/`explicit`), `ttl` (30 m; OpenRouter reports 30 m/12 h), 4 write slots. [VENDOR: Microsoft] / [INDEPENDENT: OpenRouter]

OpenAI's tool search states the design rule outright: *"Both hosted and client-executed tool search load tools at the end of the model's context window. This placement preserves the model's cache,"* and *"Changing the loaded tool set breaks the model's cache from that point forward."* [VENDOR: Microsoft [tool search](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/tool-search)]

**Gemini.** Implicit caching on 2.5+ (reads 0.25×, no write fee, TTL ~3–5 min, min 1,024 Flash / 4,096 Pro) plus explicit `CachedContent` with separately priced storage; explicit minimums/TTL/storage rate [UNVERIFIED] here. No deferred-loading primitive ([feature request](https://github.com/googleapis/python-genai/issues/2185)). [INDEPENDENT]

## 6. Tool count and naming guidance

- Threshold: "Tool selection accuracy degrades with more than 30-50 tools loaded at once"; defer when definitions exceed ~10K tokens or 10+ tools. [VENDOR]
- Namespace by service and resource (`asana_search`, `asana_projects_search`); prefix- vs suffix-namespacing has "non-trivial effects" on evaluations — measure. Names/descriptions are the retrieval surface: `search_slack_messages` beats `query_slack`. [VENDOR]
- Response hygiene: 25,000-token default cap; concise vs detailed formats (72 vs 206 tokens); actionable errors; OpenAI namespaces <10 functions. [VENDOR]

## 7. Competitor equivalents

- **OpenAI Responses**: `tool_search` (hosted, or `execution:"client"` with your own schema), `defer_loading` on functions/namespaces/MCP servers, `tool_search_call`/`tool_search_output` items, `additional_tools` for point-in-history injection, gpt-5.4+. Exists, GA. [VENDOR: Microsoft mirror]
- **OpenRouter**: `openrouter:tool_search` cross-provider (regex only) plus Anthropic native passthrough; 400 on Chat Completions; `tool_choice` must be omitted or `allowed_tools`. **LiteLLM** proxies TST across Anthropic, Bedrock (Invoke only, Claude 4.5+, no BM25), Vertex, Azure. [INDEPENDENT]
- **Gemini**: no tool search/deferral; `tool_config` controls calling mode, not catalog visibility. [UNVERIFIED]

## 8. Design implications for AMP

1. **Two planes, one cacheable prefix.** Only a stable core (3–5 tools, ~0.5–2K tokens) in `tools`; manifests never in the prefix. Anthropic/OpenAI: `defer_loading`. Gemini has no deferral, so AMP needs a flatten mode: core + one generic search/execute tool, catalog behind handles.
2. **Append-only, deterministic order.** Sort by (namespace, name) once, never by relevance/recency — reordering invalidates system+messages (Claude) and the whole prefix (OpenAI). Versions are immutable; a bump is a deliberate cold write.
3. **Byte-canonical, signed manifests.** One character is a miss. Sign a canonical serialization (sorted keys, fixed unicode/number form); the signature is a manifest field, not an envelope field.
4. **No breakpoints on deferred artifacts** (Claude 400); breakpoint the last non-deferred tool/system block.
5. **JIT expansion in the body.** Emit handle references and splice schemas into messages; keep search-result blocks verbatim so later turns re-expand without re-searching.
6. **Budget the rendered prefix, not the request body.** Deferred defs ship every request, so wire size ≠ context size; a body-counting budget over-triggers.
7. **Handles over payloads.** PTC (200 KB→1 KB) and code-exec MCP (150K→2K) justify sandbox + handles; cap inline results (~25K), return handles beyond.
8. **TTL math + affinity.** 1-hour writes (2×) beat repeated 1.25× rewrites after ~2 rewrites; keep `prompt_cache_key`/sticky routing.
9. **Capability flags, not assumptions**: `deferral`, `explicit_breakpoints`, `max_breakpoints`, `min_prefix`, `ttl_options`.

## 9. Confidence and gaps

High: TST fields/shape, `mcp_toolset`, 72K→8.7K, 49→74, 79.5→88.1, 43,588→27,297, 72→90, cache ordering/invalidation (AWS verbatim), OpenAI 1,024/128-token/append-at-end, 30–50 threshold, 10,000 catalog. Medium: `limit` ceiling and regex/BM25 caps (single [INDEPENDENT] source); per-model minimum-prefix divergence (Opus 4.7: 2,048 vs 4,096). Gaps: PTC error/large-output semantics [UNVERIFIED]; Anthropic's first-party caching page unreachable here; Gemini explicit-caching numbers [UNVERIFIED]; the 30–50 threshold is a vendor assertion with no published curve.
