# MCP/LCP 工具上下文平面审计报告

**主题范围**：MCP/LCP 工具上下文平面；四个北向入口、Manifest Store / Retriever / Budgeter / Executor / Shaper / Policy & Audit、南向 MCP、Manifest/Budget/Handle 契约、四类 token 成本、检索/门控/代码执行/输出整形/CLI、缓存、权限、安全、路线和模块关系。  
**审计日期**：2026-11-06  
**证据标记**：

- **[源文档]**：直接来自《MCP 的 Token 税·下一代工具协议技术尽调（2026）》或 `refract.md`；这是项目内已有设计/论证，不等于本报告独立复现。
- **[论文补充]**：来自本报告检索到的论文摘要/论文页面；论文数字和结论按其摘要口径转述，不把预印本当作生产事实。
- **[审计结论]**：本报告对可行性、缺口、边界和优先级的独立判断。

> **一句话结论 [审计结论]**：不应重造一个替换 MCP 的南向协议；应在 MCP 之上建立一个北向稳定、南向兼容的工具上下文平面。模型只看到四个稳定入口，平面负责清单、检索、预算、执行、结果整形和审计。LCP 的核心不是“把 JSON 换成更短的 JSON”，而是把“何时让模型看到什么、看到多少、以什么权限看到”变成可验证、可缓存、可撤销的运行时决策。

---

## 1. 审计对象与范围

本报告只审计工具上下文平面，不把 LCP 扩展为完整 Agent 操作系统。审计对象包括：

1. **北向（Northbound）**：模型或 Agent 可调用的固定入口：`find_tools`、`inspect_tool`、`run`、`read_handle`。
2. **上下文平面（Context Plane）**：Manifest Store、Retriever、Budgeter、Executor、Shaper、Policy & Audit 六个模块及其状态、缓存、事件和失败处理。
3. **南向（Southbound）**：现有 MCP 服务器和 `server/discover`、`tools/list`、`tools/call` 等能力。
4. **契约**：Manifest、Budget、Handle 三类最小契约，以及它们与 MCP 原生 schema、权限、版本和审计凭证的关系。
5. **经济学**：定义税、结果税、往返税、协议税；缓存如何改变实际账单；检索、门控、代码执行、输出整形、CLI 的适用边界。
6. **治理与路线**：安全、租户隔离、供应链、提示词注入、动态描述投毒、预算超限、可观测性、MVP 路线。

不在本报告范围内：完整 MCP 规范的所有资源/UI/采样语义；`refract.md` 中与工具上下文无直接关系的职业、协作和文件模块细节。相关部分只在其能约束工具上下文时引用。

---

## 2. 证据基线：源文档说了什么，论文补充了什么

### 2.1 源文档的直接主张

《MCP 的 Token 税》把问题定义为“工具说明书与工具结果吞噬上下文”，并把成本分成四类：定义税、结果税、往返税、协议税。[源文档] 其建议的三种杠杆是：

- **推迟（defer）**：工具定义按需检索和展开；
- **外置（externalize）**：把多步编排搬到沙箱/代码执行，避免中间结果回到模型；
- **压缩（compress）**：分页、句柄、摘要或紧凑编码改变结果粒度。

源文档列出的 LCP 形态是“北向四个固定工具 + 上下文平面 + 南向 MCP”。其参考架构把 `Manifest Store`、`Retriever`、`Budgeter`、`Executor`、`Shaper`、`Policy & Audit` 放在模型和 MCP 服务器之间，并提出 Manifest/Budget/Handle 三份契约。[源文档]

源文档同时给出了一组厂商、第三方测量和模拟数据，例如 Tool Search 的 72K→8.7K、Cloudflare Code Mode 的约 1K 级描述、Tool Attention 模拟的 47.3K→2.4K，以及某些供应链/跨租户/提示词注入案例。[源文档] 这些数据应作为路线信号和待复测基线，不应直接写成组织的 SLA。

### 2.2 `refract.md` 可复用的架构约束

`refract.md` 的核心思想是“上下文是注意力调度结果”，并以 Session/Turn 作为交互容器和预算边界。[源文档] 对工具上下文平面最有价值的约束有：

- 渐进披露：先 list/摘要，按需展开；
- `mount / unmount / persist / focus / blur / update / associate / verify` 八个注意力操作；
- L3 路由/聚焦/切换/抑制，L4 只装配摘要、指针和当前 Action；
- 预算树：Session→Turn→Intent→Mission→Goal→Plan→Task→Action；
- Tool/Skill/Protocol 有版本、前置条件、成功标准、失败分类和生命周期；
- 每次调用产生 Receipt，验证层不接受没有操作历史凭证的“已完成”；
- stale、版本哈希、撤销传播、事件溯源和确定性验证器优先于“让模型自己记住规则”。

[审计结论] 这些约束应被投影到 LCP，而不是把 `refract.md` 的全部层级搬进每次工具调用。上下文平面只需要消费最小的 `Session/Turn`、当前 Task、权限上下文、预算余额和 Receipt 指针；视图渲染、完整事件流、证据图不应进入模型上下文。

### 2.3 论文补充与边界

本报告检索到的论文进一步支持“外部检索/候选压缩/程序化调用”，但也提示三项边界：

1. **NTILC [论文补充]**：`NTILC: Neural Tool Invocation via Learned Compression`（arXiv:2606.06566，2026-06）把工具规范和用户意图映射到共享嵌入空间，外部检索后只给模型选中的 schema；摘要报告上下文消耗降低超过 95%、推理延迟最高降低 74%。这支持 Retriever 的方向，但它依赖训练的签名感知检索器，不能假定对未知 MCP 生态零配置有效。来源：[arXiv:2606.06566](https://arxiv.org/abs/2606.06566)。
2. **Toollery [论文补充]**：`Toollery: Scaling LLM Agents to Thousands of Skills and Tools`（arXiv:2609.22218，2026-09，v2 2026-10）采用工具侧查询扩展，把大注册表压缩为固定 top-K 候选；摘要称在约 79K 技能、440+ 原子工具和 220 工具驾驶舱数据上改善召回/选择，但明确指出收益依赖工作负载覆盖与 provider caching。它支持“检索候选集有上限”，也反驳“只要向量检索就一定省钱”。来源：[arXiv:2609.22218](https://arxiv.org/abs/2609.22218)。
3. **Plan-or-Retrieve [论文补充]**：`Plan or Retrieve First?`（arXiv:2610.19068，2026-10）在 46,984 个端点上发现：单工具问题 Retrieve-then-Plan 更好，多工具问题 Plan-then-Retrieve 更好；后者额外发现调用大致使推理成本翻倍。故 Retriever 应支持复杂度自适应，而不是固定采用一个检索顺序。来源：[arXiv:2610.19068](https://arxiv.org/abs/2610.19068)。
4. **PTC [论文补充]**：`The Bitter Lesson of Tool Calling`（arXiv:2608.06370，2026-08）在 BFCL v4 的 14 个模型上比较程序化调用与原生 JSON 调用，摘要报告 PTC 在 11/14 个模型上不差于或优于基线，平行 fan-out 时 13/14 个模型保持不差，并对上下文腐化更稳。它为 Executor 提供了独立于厂商博客的支持，但仍是基准测试，不等价于高风险生产执行。来源：[arXiv:2608.06370](https://arxiv.org/abs/2608.06370)。
5. **MCP-DPT [论文补充]**：`MCP-DPT`（arXiv:2604.07551，2026-04）将 MCP 防御按层放置，指出现有防护偏向工具侧，而宿主编排、传输和供应链层存在持续空白。该结论直接支持 Policy & Audit 必须位于上下文平面，而不能只依赖 MCP 服务器自报安全。来源：[arXiv:2604.07551](https://arxiv.org/abs/2604.07551)。

---

## 3. 目标架构：四个北向入口、六个平面模块、一个 MCP 南向适配面

### 3.1 总体数据流

```text
用户输入 / Session + Turn
        │
        ▼
┌──────────────────────────────┐
│ Northbound: 四个固定入口       │
│ find_tools / inspect_tool      │
│ run / read_handle              │
└───────────────┬──────────────┘
                ▼
┌─────────────────────────────────────────────────┐
│ LCP Context Plane                               │
│ Manifest Store → Retriever → Budgeter            │
│                         │        │               │
│                         ▼        ▼               │
│                    Executor → Shaper             │
│                         │                         │
│                  Policy & Audit（贯穿）            │
└─────────────────────────┬───────────────────────┘
                          ▼
┌─────────────────────────────────────────────────┐
│ Southbound MCP                                 │
│ server/discover / tools/list / tools/call       │
└─────────────────────────────────────────────────┘
```

[源文档] 设计约束是：北向接口面积恒定，南向服务器数量可增长；模型看到的是能力目录和按需详情，而不是全量服务器 schema。 [审计结论] “四个入口恒定”必须理解为**模型可见的调用面恒定**，不是内部只有四个函数；平面内部仍需要索引、缓存、租户策略、执行绑定、回执和故障队列。

### 3.2 四个北向入口

| 入口 | 模型可见职责 | 进入上下文的内容 | 必须禁止的事情 |
|---|---|---|---|
| `find_tools(query, filters?)` | 从 Manifest 摘要中检索可用能力 | top-k 摘要、权限状态、置信度、版本/digest 指针 | 返回未授权工具；低置信度硬塞“最像”的工具 |
| `inspect_tool(id, version?/digest?)` | 展开一个工具的权威调用 schema、前置条件和错误契约 | 完整输入 schema、输出上限、权限和示例 | 使用与 Manifest digest 不同的实时描述 |
| `run(code, budget, policy_ref?)` | 在受控执行环境中程序化编排一个或多个工具 | 代码结果摘要、Receipt、句柄/分页指针 | 让代码绕过 Policy、任意出站、任意密钥读取 |
| `read_handle(id, cursor/limit, projection?)` | 取回被预算器外置的大结果 | 指定切片、摘要或投影、句柄状态 | 跨租户读取、绕过过期/撤销、无界全量读取 |

#### 3.2.1 `find_tools`

检索输入应包含当前 Turn、Task 摘要、用户/Agent 身份、资源范围和可用预算，但原始敏感数据不应直接成为索引查询。返回至少包括：`tool_id`、`server_id`、版本、digest、简短签名、`when`、权限状态、前置条件状态、匹配分数和过期时间。低置信度时返回空或要求澄清，而不是挑一个“最不差”的工具。[审计结论]

#### 3.2.2 `inspect_tool`

`inspect_tool` 是 Manifest 的权威展开点。短签名只能用于候选筛选；实际参数校验、枚举、互斥约束、输出结构和错误分类仍必须来自完整 schema 或等价的可验证契约。任何“短签名直接执行”的实现都会把节省的定义 token 换成参数错误和重试成本。[审计结论]

#### 3.2.3 `run`

`run` 是收益最大、风险最高的入口。它需要同时绑定：执行代码、工具版本/digest、Session/Turn、Budget、Policy、出站白名单、凭证引用、资源限额和取消信号。模型只看到最终摘要；平面保存代码、子调用、原始结果和审计链。

#### 3.2.4 `read_handle`

句柄不是“把大结果藏起来”的字符串，而是一个带所有权、租户、创建者、来源 digest、数据分级、TTL、游标、可读权限、撤销状态和审计引用的对象。句柄读应遵循最小投影原则：默认只返回所需字段和有限行数，禁止由模型一次性恢复全部原始数据。[审计结论]

---

## 4. 六个上下文平面模块及模块关系

### 4.1 Manifest Store：清单真相、版本和缓存

**职责 [源文档]**：保存服务器能力卡片和轻量摘要，支持签名、digest、TTL、按需详情。  
**审计强化 [审计结论]**：Manifest Store 至少分为四种对象：

1. **Server Manifest**：服务器身份、协议版本、能力、端点、认证方式和租户范围；
2. **Tool Summary**：工具名、短签名、何时使用、禁止条件、风险等级；
3. **Authoritative Schema**：完整输入/输出 schema、错误契约和示例；
4. **Binding Record**：某版本/digest 与南向 `tools/call`、Executor SDK 或 CLI 适配器的绑定。

Manifest 的缓存键不能只有工具名，至少要含 `tenant_id + server_id + tool_id + version + digest + policy_scope`。服务端返回的 `ttlMs` 是缓存建议，不是授权期限；权限撤销、供应链事件和 digest 变更必须能主动失效。

### 4.2 Retriever：候选压缩而非盲目相似度

Retriever 应采用混合流程：词法/BM25 负责专有名词，向量负责语义，签名/类型约束负责可执行性，Policy 负责权限和状态门控，历史成功率只作为低权重特征。结果排序可抽象为：

```text
score(tool) = semantic + lexical + signature_fit
              + state_ready + freshness
              - risk - estimated_cost
```

[论文补充] NTILC 表明签名感知的损失可以区分“语义相似但参数不兼容”的工具；Toollery 表明工具侧查询扩展可以在大注册表上固定 top-K；Plan-or-Retrieve 表明单工具和多工具任务需要不同检索顺序。 [审计结论] Retriever 应至少有三条路由：

- **简单任务**：Retrieve-then-Plan，先拿 top-k；
- **多工具任务**：先生成抽象能力 stub，再联合检索；
- **不确定任务**：先检索候选，再要求 `inspect_tool` 验证；若 top-1 分数低，询问用户或扩大候选，而不是无界扩展。

检索召回率、精确率、工具选择准确率、误调用率和因召回失败导致的任务失败率必须分开测量。不能只看 token 下降。

### 4.3 Budgeter：把软提示变成硬预算

Budgeter 管理至少五个维度：输入定义 token、单次结果 token、Session/Turn 总 token、执行时间、工具调用/重试次数。它还应管理内存、CPU、并行度、出站字节、句柄存储 TTL 等非 token 预算。

预算超限的默认动作不应是静默截断，而应按策略执行：

```text
if result > max_result_tokens:
    on_exceed = handle | paginate | summarize_with_pointer | error
```

Budgeter 与 `refract.md` 的预算树对齐：Session 有总预算，Turn 取得本轮额度，Task/Action 获得子额度；未用额度可回收，超支必须上升决策。每次工具调用要记录“预算前、实际消耗、超限动作、最终账单”。

### 4.4 Executor：代码编排、绑定和沙箱

Executor 将南向 MCP 工具映射为受类型约束的函数或 CLI 适配器。在沙箱内执行模型生成的代码，执行期间保留中间结果，最终只向模型返回 Shaper 的结果。

最低安全基线：

- 默认无网络；出站只允许显式域名/方法/端口白名单；
- 默认无文件系统和环境变量读取；密钥只以短期引用注入；
- CPU、内存、并发、墙钟、子进程和输出字节限额；
- 代码、依赖、工具 binding 和 Manifest digest 固定；
- 取消、超时、重试和幂等键由运行时强制；
- 所有子调用产生可关联 Receipt，原始结果进入受控存储，不自动进入模型。

[论文补充] PTC 在 BFCL v4 上支持程序化调用的稳健性，但基准不覆盖所有沙箱逃逸、供应链、数据外传和高风险写操作。 [审计结论] “代码执行更省 token”不能作为放宽安全边界的理由；Executor 是高风险模块，必须和 Policy & Audit 同步上线。

### 4.5 Shaper：表示选择、信息损失和可回溯

Shaper 负责分页、聚合、投影、摘要、紧凑编码和句柄化。输出形态必须同时给出：内容、格式、是否完整、来源、截断/分页状态、可回溯指针和 digest。

建议优先级：

1. 服务端过滤和聚合；
2. 字段投影和分页游标；
3. 大对象句柄；
4. 可逆/可验证的结构化编码；
5. 仅在离线或低风险场景使用模型摘要。

TOON 或类似编码不能只按压缩率验收。源文档引用的独立评测指出紧凑编码可能伴随准确率损失。[源文档] [审计结论] Shaper 必须用任务成功率、解析失败率、事实遗漏率和 token p95 共同验收；原始数据必须可用句柄回读，避免不可逆摘要成为唯一真相。

### 4.6 Policy & Audit：跨模块的执行闸门

Policy & Audit 不是附属日志模块，而是每个入口和每条数据流的强制闸门。它负责：

- 身份认证、租户和对象级授权；
- 工具/服务器/版本/digest 的信任状态；
- 只读、写入、删除、外传等风险级别；
- 人工确认、双人审批和可回滚条件；
- 预算、出站和速率限制；
- Receipt、Evidence、trace/span、原始响应和句柄生命周期；
- 供应链签名、撤销、密钥轮换和事件响应。

[论文补充] MCP-DPT 的 defense-placement 结论表明，仅在工具侧做防护会遗漏宿主编排、传输和供应链边界。 [审计结论] Policy 必须前置于检索（未授权工具不应被召回）、前置于 inspect（不应泄漏隐藏 schema）、前置于 run（执行前检查）、前置于 read_handle（数据读权限和租户校验），并在结果出口再次检查数据外传策略。

---

## 5. 南向 MCP：兼容层而不是信任层

南向适配器应最大化复用现有 MCP 服务器，同时把 MCP 自报信息转成待验证的 Manifest。典型流程：

```text
server/discover
   → 取服务器身份/版本/能力/认证声明
tools/list
   → 获取工具摘要与完整 schema，校验稳定排序、TTL、digest
tools/call
   → 执行具体调用，绑定预算、租户、权限和 Receipt
```

[源文档] 2026-07-28 规范相关主张包括无状态请求、`server/discover`、`ttlMs`/`cacheScope`、稳定排序和将 tasks 作为扩展。 [审计结论] 即便这些特性已在目标环境采用，也不能把 MCP 的 `ttlMs`、工具描述或远程端点当作安全事实：

- Manifest Store 必须验证签名、digest、端点所有权和版本漂移；
- `tools/list` 的结果只能成为候选输入，不能跳过 Policy；
- 南向会话/重试和北向缓存必须解耦；
- MCP 错误应归一为可审计的错误分类，不把服务器原始文本直接当作模型指令；
- 远程服务器返回的描述、资源文本和错误消息都属于不可信数据。

南向兼容的真正价值是生态覆盖，而不是自动带来安全或成本收益。

---

## 6. Manifest / Budget / Handle 三份契约审计

### 6.1 Manifest 契约

源文档示意的 Manifest 包含 `id`、版本、digest、TTL、tags、工具短名、短签名和 `when`。[源文档] 生产契约建议补充：

```json
{
  "server_id": "github",
  "tool_id": "create_pr",
  "version": "2.1.0",
  "digest": "sha256:...",
  "summary": "创建 Pull Request",
  "signature": {"required": ["repo", "head", "base"], "optional": ["title", "body"]},
  "when": ["已有变更并需要提交 PR"],
  "not_when": ["只需读取 issue"],
  "auth": {"scopes": ["repo:write"], "risk": "write"},
  "preconditions": ["repo_access", "branch_exists"],
  "output": {"shape": "object", "max_default_tokens": 400},
  "ttl_ms": 3600000,
  "cache_scope": "tenant",
  "signature_ref": "sigstore-or-equivalent"
}
```

**审计结论**：短 Manifest 只能是导航和决策元数据；执行权威是 `inspect_tool` 得到的、与 digest 绑定的完整 schema。`when` 必须是可评测的使用条件，而不是营销描述；`not_when` 和风险标签对于减少误调用同样重要。Manifest 变更应产生版本、审批和重新索引事件。

### 6.2 Budget 契约

源文档的 Budget 示意包括 `max_result_tokens`、`format`、`on_exceed` 和 `deadline_ms`。[源文档] 生产契约应进一步包含：

- `max_input_tokens`、`max_output_tokens`、`max_total_tokens`；
- `max_calls`、`max_retries`、`max_parallelism`；
- CPU、内存、墙钟、网络字节和存储 TTL；
- `cost_center`、模型/Tokenizer 版本和计费口径；
- `on_timeout`、`on_cancel`、`on_policy_denied`；
- `idempotency_key` 与可回滚策略。

Token 预算必须声明 tokenizer/模型版本。不同模型对同一 JSON、Markdown、TOON 的 token 数不同，不能用字符长度代替 token 计量。

### 6.3 Handle 契约

源文档把大结果留在执行侧，只回 `h_...` 句柄并按 cursor/limit 读取。[源文档] 句柄至少应包括：

```text
Handle = {
  id, owner, tenant_id, session_id, turn_id,
  source_receipt_id, source_digest,
  data_classification, schema_version,
  created_at, expires_at, revocation_epoch,
  allowed_projections, max_page_size,
  cursor_binding, status: active|expired|revoked|deleted,
  audit_ref
}
```

句柄读必须校验：调用者身份、租户、Session/Turn 绑定、Policy scope、来源 digest、TTL、撤销 epoch 和 cursor 绑定。句柄 ID 不应可猜测；读取需防重放、分页侧信道和跨租户缓存命中。高敏感数据句柄应支持一次性读取或强制二次确认。[审计结论]

---

## 7. 四类 token 成本：定义、结果、往返、协议

### 7.1 定义税（Definition Tax）

已连接工具 schema 每轮重复进入模型上下文，近似为：

```text
C_definition ≈ turns × tokens(tool definitions actually mounted)
```

[源文档] 典型问题是全量 `tools/list` 加载，工具越多，模型越难在相似候选中区分。定义税相对适合缓存，但前提是前缀稳定、顺序稳定、租户/权限范围稳定。优化：延迟加载、Manifest、检索、门控、稳定排序。

### 7.2 结果税（Result Tax）

工具原始结果一旦进入历史，后续轮次可能反复重放。若第 `i` 轮新增结果为 `r_i`，历史重放成本近似：

```text
C_result ≈ Σ(i=1..N) (N - i + 1) × r_i
```

在均匀结果大小下呈二次增长。 [源文档] 这解释了为什么“先治结果、后治定义”通常更正确：句柄、分页、过滤、聚合和代码执行优先于单纯缩短 schema。结果税还包括工具错误文本、日志、重复键名、无关字段和视觉截图等隐性内容。

### 7.3 往返税（Round-trip Tax）

自然语言模式是：模型决定→工具调用→模型读结果→模型再决定。多步任务的推理次数、延迟和错误机会随调用步数增长。代码模式把循环、条件、并行和聚合放到 Executor，减少模型往返。

往返税未必等于 token 数；它还包含网络 RTT、模型首 token 延迟、重试、上下文重组和人工确认等待。因此应同时采集调用数、LLM turn 数、端到端 p95、重试率和成功率。

### 7.4 协议税（Protocol Tax）

握手、会话状态、能力协商、重连、轮询和状态同步通常不是最大 token 项，但会导致缓存失效、水平扩展困难和重试成本上升。无状态、稳定排序、TTL、异步任务和退避能降低协议税。[源文档]

### 7.5 优先级和计量

推荐计量顺序：

1. 单任务结果 p50/p95/p99、历史结果重放量；
2. 每轮工具定义 tokens 和 cache hit；
3. LLM 往返数、工具调用数、重试数和时延；
4. 握手/发现/轮询/重连开销。

每个 Turn 的账单应能按 `server/tool/version/digest/tenant/task/receipt` 归因。没有这些维度，任何“节省 80%”都不能指导生产决策。

---

## 8. 五种优化机制与 CLI 的位置

### 8.1 检索式加载：默认基线

适用于工具数大于约 10、定义超过团队预算的场景。北向只常驻 `find_tools` 和小型 Manifest；top-k 命中后才 `inspect_tool`。风险是漏召回、别名/专有名词错配和多一次检索调用。必须提供低置信度空结果、用户澄清和 fallback。

### 8.2 网关门控：企业治理入口

网关按意图、权限、状态、租户、环境和风险筛选候选。它能统一审计、计费、密钥和限流，但成为高价值单点，必须做多副本、缓存一致性、策略版本化、熔断和离线降级。门控不能只按语义相似度；“未登录”“只读任务”“生产写操作”是硬过滤条件。

### 8.3 代码执行：数据密集和多步任务的加速器

代码执行最适合批量查询、过滤、聚合、跨服务器关联和并行 fan-out；不适合一次简单查询，或没有成熟沙箱、审计和权限模型的环境。Executor 的结果不应是任意代码的黑盒；应提供类型化绑定、固定 SDK、受限标准库和可观察子调用。

### 8.4 输出整形：低门槛但需谨慎

分页/投影/句柄通常比换编码更可靠。紧凑编码只有在模型解析稳定、失败可回读、内容可验证时才适合。任何摘要都必须附原文句柄和来源 Receipt；不能用二进制传输来宣称“省 token”，因为真正进入提示词的仍然是渲染后的文本。

### 8.5 CLI 优先：反向基准线

已有成熟 CLI（如 `git`、`gh`、`curl`）时，直接使用 CLI 可能具有近零定义成本和更强组合性。 [源文档] 但 CLI 的安全边界更粗：shell 注入、任意文件/网络权限、跨平台差异和错误结构化不足。LCP 应允许 CLI 作为 Southbound adapter，并把命令、参数、环境、出站和输出同样纳入 Policy、Budget、Receipt；不是简单给模型一个无限 shell。

**审计规则 [审计结论]**：如果 CLI 已能完成任务且不需要有状态交互，不应为了“协议统一”再包一层 MCP。若需要对象级权限、结构化结果、长任务、可撤销或跨租户治理，再使用 LCP/MCP。

---

## 9. 缓存：稳定性优先于压缩率

缓存分为五层：

1. **Manifest 缓存**：服务器能力卡片、工具摘要；键含 tenant/policy scope/version/digest；
2. **Schema 缓存**：`inspect_tool` 完整 schema；必须绑定 digest；
3. **Retriever 索引缓存**：词法、向量、签名索引；工具变更增量更新；
4. **Executor 结果缓存**：仅对幂等、低敏感、明确 TTL 的查询；
5. **Prompt/Provider cache**：保持北向固定前缀和稳定顺序，动态内容放在后缀或受控区域。

缓存命中不是免费：

- 权限变化必须主动失效；
- 仅靠 TTL 会在撤销窗口内暴露旧能力；
- 多租户必须禁止共享敏感结果缓存；
- Manifest 描述和实现 digest 不一致时，宁可 miss 也不能命中旧绑定；
- 缓存 key 不应包含原始用户秘密或可被注入的任意文本；
- 观测 `hit/miss/stale/eviction` 与 token、成功率联合指标。

[源文档] 认为稳定工具排序可提升 prompt cache。 [审计结论] 应把“稳定序列化”视为契约：字段顺序、工具排序、Manifest 版本和空值编码保持确定；不应为了小幅压缩频繁重排，导致前缀全失效。

---

## 10. 权限、安全与威胁模型

### 10.1 威胁面

| 威胁 | 发生位置 | 必须的控制 |
|---|---|---|
| 工具描述提示词注入 | Manifest/错误/资源文本 | 不可信数据标记；描述与指令分离；Policy 不由模型决定 |
| 动态元数据投毒 | Store/Retriever/服务器热更新 | 签名、digest、版本锁、变更重审、运行时校验 |
| 跨租户缓存泄漏 | Store/Handle/结果缓存 | tenant-bound key、对象级授权、缓存前校验 |
| confused deputy | 网关/服务器 | 代表谁调用必须显式传递；服务端对象级授权；禁止共享万能凭证 |
| 高权限密钥外泄 | Executor/CLI/MCP | 最小 scope、短期凭证、默认只读、出站白名单、不可读环境变量 |
| 供应链恶意服务器 | stdio/npm/容器 | 签名制品、SBOM、锁版本、扫描、沙箱、运行时撤销 |
| 代码沙箱逃逸 | Executor | syscall/网络/FS 隔离、资源限额、镜像最小化、故障注入 |
| 句柄猜测/重放 | `read_handle` | 高熵 ID、绑定 Session/tenant/cursor、TTL、epoch、审计 |
| 无界结果耗尽 | Shaper/Budgeter | 硬预算、分页/句柄、深度/行数限制、背压 |
| 检索误召回 | Retriever | 权限前置过滤、签名兼容、低置信度空结果、人工澄清 |

### 10.2 三条硬安全边界

1. **最小权限**：工具、服务器、用户、租户、环境和数据对象都按最小 scope；默认只读，写/删/外传单独授权。
2. **出站白名单**：沙箱和服务器不能把工具调用当作任意网络代理；域名、方法、端口、数据分类和目的地必须策略化。
3. **高风险人工确认**：生产写入、删除、支付、外部发布、敏感数据导出和权限提升必须人审或双重确认；确认对象应包含参数摘要、影响范围、目标、预算和回滚方式。

### 10.3 审计链

每次入口调用至少记录：`who/what/why/when/where`、Session/Turn、Manifest digest、Policy 版本、Budget、代码 hash、南向端点、工具参数摘要、结果摘要、句柄、耗时、错误、人工确认和最终状态。Receipt 应签名、锚定工作快照、可验证、可争议、可撤销；撤销某个 Manifest 或凭证时，必须能找出受影响的 Handle、Receipt、Evidence 和结论。

---

## 11. 与 `refract.md` 的模块关系

以下映射是本报告针对工具上下文平面的裁剪，不是对 `refract.md` 全架构的复制：

| `refract.md` 层/对象 | 在 LCP 中的投影 | 进入模型上下文的内容 |
|---|---|---|
| L0 外部资源 | MCP/CLI/知识服务器适配器 | 仅摘要和指针 |
| L0.7 Tool/Skill/Protocol | Tool Registry + Manifest 版本/契约 | 当前候选的短契约 |
| L1 Session/Turn/预算树 | Budgeter、调用绑定、恢复/取消 | Session/Turn 摘要和预算余额 |
| L2 注意力对象 | Manifest、候选、schema、句柄作为对象 | mounted 的摘要/指针 |
| L3 注意力调度 | Retriever + Policy 状态门控 | 当前焦点和选择理由的短摘要 |
| L4 上下文组装 | Northbound prompt 装配 | 目标、约束、当前 Action、工具详情 |
| L6 确定性验证 | Schema、流程、权限、输出和 Budget 校验器 | 失败原因和下一步建议 |
| L7 Evidence | Receipt/Handle/Manifest 证据链 | 结果来源摘要和置信度 |
| 横切可观测性 | token 归因、事件溯源、熔断、幂等 | 通常不进上下文 |
| Workspace/文件对象 | Executor 运行目录和快照锚点 | 只给必要路径/版本指针 |

[审计结论] LCP 不能绕开 `refract.md` 的 Turn 边界：工具详细输出默认不跨 Turn 持久化；活跃 Task、预算余额、未完成句柄和必要 Receipt 指针才可 persist。`mount` 必须带预算和过期条件；`stale` 对象禁止继续调用，需重新 discover/inspect；Agent 看到的是短错误和修复动作，不是完整内部视图。

---

## 12. 失败模式与审计修正

### 12.1 只做全量网关聚合

把所有服务器 schema 合并到一个“万能 MCP”不会消除定义税，只会制造单点故障、权限耦合和更大的攻击面。正确做法是网关只暴露检索/路由，schema 按需展开。

### 12.2 只做向量检索

向量相似不等于可执行、可授权或已就绪。没有词法、签名、状态、权限和低置信度空结果，系统会把“未登录/不可用/危险”工具送给模型。

### 12.3 只压缩 schema

缩写字段名、换编码或把描述写成难懂的天书，会降低区分度和参数准确率。定义税节省可能被误调用和重试反弹；应先分离目录和详情。

### 12.4 只依赖 Prompt Cache

缓存无法修复无关信息占用、权限变化、租户差异和结果税。只有稳定前缀、明确 cache scope、主动失效和结果外置同时成立时，缓存才有经济意义。

### 12.5 把 `max_result_tokens` 当作“截断阈值”

硬截断会丢掉关键尾部或破坏 JSON。超限应转 Handle、分页或返回结构化错误；原始数据保留可追溯引用。

### 12.6 让模型自己决定权限和预算

“请只读”“请不要泄露”“请控制输出”都是软约束。Policy、Budgeter、Executor 和 Shaper 必须在模型之外强制执行；模型最多提出请求，不能授予自己权限。

### 12.7 代码执行无可观测性

只记录最终代码或最终摘要不足以追责。必须记录子调用 DAG、参数摘要、版本/digest、网络访问、资源消耗、输出整形和策略判定；否则省下 token 却失去验证能力。

---

## 13. 推荐实施路线

### P0：计量和基线（约 2 周）

不改 MCP 服务器，先采集：

- 每轮定义 token、每次结果 token、历史重放 token；
- cache hit/miss/stale；
- 工具检索/选择准确率、误调用、重试；
- LLM 往返数、南向调用数、p95 时延；
- 每工具/租户/任务的失败和权限拒绝；
- Handle 读取、分页、超限和撤销事件。

交付：可按 Session/Turn/Task/Tool/Receipt 归因的账单看板。任何目标值必须以 P0 实测替换源文档示例。

### P1：兼容代理 MVP（约 4–6 周）

实现 Manifest Store、混合 Retriever、Budgeter、基础 Shaper 和 Policy 前置过滤；保留原生 MCP fallback。先启用分页、投影、句柄和低置信度空结果，再尝试紧凑编码。目标不是单纯 token 最低，而是定义、结果、重试和成功率一起改善。

### P2：代码模式（约 6–10 周）

为高频、低风险、幂等工具生成类型化 binding；部署隔离 Executor、出站白名单、资源限额和 Receipt；用 shadow/canary 对比原生 JSON 调用。只把数据密集、多步、可并行任务迁移到 `run`，简单查询保留 `inspect + call` 降级路径。

### P3：契约和治理（4 周起）

将 Manifest/Budget/Handle 作为 MCP 扩展或 profile 提案；补齐签名、撤销、租户隔离、审计查询、Policy 版本迁移和安全测试。保持南向 MCP 兼容，避免 fork。

### 建议验收指标

| 指标 | 目标方向 | 不能单独解释的原因 |
|---|---|---|
| 定义 token/轮 | 下降 | 可能换来召回失败 |
| 结果 token p95、历史重放量 | 显著下降 | 必须保留可回溯性 |
| 工具选择准确率/召回率 | 上升 | 需按单工具/多工具分层 |
| LLM 往返数、p95 时延 | 下降 | 并行执行可能增加运行资源 |
| Prompt cache hit | 上升且稳定 | 需按租户和策略 scope 分解 |
| 任务成功率/副作用率 | 不下降/上升 | 是所有压缩方案的硬门槛 |
| 权限拒绝正确率、跨租户泄漏 | 零重大事件 | 安全指标不可用平均值掩盖 |
| Receipt 完整率、撤销可达率 | 100%/可验证 | 无审计就无法证明成本和安全 |

---

## 14. 最终审计结论

### 14.1 可采纳

- **四入口北向 + MCP 南向兼容**：接口面积稳定，能承接生态网络效应。
- **Manifest 与 schema 分离**：是定义税治理的基础，但短签名不能替代权威 schema。
- **混合检索 + 状态/权限门控**：比纯向量检索安全且可解释；复杂度自适应值得实验。
- **Budgeter + Handle**：是结果税治理的核心，必须把超限动作写进契约。
- **代码执行**：对多步、数据密集和并行任务具有最大收益，但必须以沙箱、出站和审计为前置条件。
- **稳定缓存和 digest**：真实经济学常常优于继续压缩几十个 token。
- **CLI 作为适配器和反向基准**：已有 CLI 的场景不应为了 MCP 统一而增加一层。

### 14.2 需要保留条件

- 源文档的厂商数字、registry 计数、攻击案例和未来规范描述应以来源和测量时点标注，不能直接作为普适事实。
- 论文结果多为预印本、基准或模拟；应在实际模型、Tokenizer、租户、权限和数据分布上复测。
- “四个入口固定”不意味着执行风险固定；`run` 和 `read_handle` 仍可形成强大数据面。
- 输出编码压缩不能以 token 下降作为唯一验收；准确率、遗漏和回溯优先。
- 缓存不能替代授权；TTL 不能替代撤销；Manifest 不能替代运行时 Policy。

### 14.3 不建议

- 从零替换 MCP 的 wire protocol；
- 全量聚合所有 schema 后指望缓存解决一切；
- 仅靠提示词约束权限、预算和出站；
- 把任意 shell 或任意代码作为“低成本工具”；
- 让动态、未签名、未经租户绑定的描述进入高权限执行路径；
- 在没有 P0 计量时承诺固定的 token 降幅。

**最终判断 [审计结论]**：LCP 应被实现为 MCP-compatible profile + context-plane runtime，而不是全新协议。其成功标准不是“模型能看到更多工具”，而是：模型在每个 Turn 只看到与当前目标、权限、预算、状态和证据相匹配的最小信息；执行侧可以完成更多工作，但结果、权限、版本和审计都不越界。

---

## 15. 参考资料（仅列本报告实际使用）

### 项目内源文档

- `MCP-Token税与下一代工具协议.html`：成本四分法、检索/门控/代码执行/输出整形/CLI、LCP 四入口和六模块、Manifest/Budget/Handle、缓存、安全与路线。
- `refract.md`：注意力调度、Session/Turn、预算树、Tool/Skill/Protocol 生命周期、Receipt/Evidence、上下文组装、stale/版本/审计/撤销约束。

### 论文补充

- Andrew Krikorian, Yayuan Li, Jason J. Corso, “NTILC: Neural Tool Invocation via Learned Compression”, arXiv:2606.06566（2026）。[论文页面](https://arxiv.org/abs/2606.06566)
- Xiangxi Tian, Ran Guan, “Toollery: Scaling LLM Agents to Thousands of Skills and Tools”, arXiv:2609.22218（2026，v2）。[论文页面](https://arxiv.org/abs/2609.22218)
- Mehrdad Rostamzadeh et al., “MCP-DPT: A Defense-Placement Taxonomy and Coverage Analysis for Model Context Protocol Security”, arXiv:2604.07551（2026）。[论文页面](https://arxiv.org/abs/2604.07551)
- Ishan Patel et al., “The Bitter Lesson of Tool Calling”, arXiv:2608.06370（2026）。[论文页面](https://arxiv.org/abs/2608.06370)
- Mingfei Zhang et al., “Plan or Retrieve First? A Scale Study of Tool Discovery Architectures”, arXiv:2610.19068（2026）。[论文页面](https://arxiv.org/abs/2610.19068)

> 注：外部论文仅作为资料补充；本报告没有把外部页面中的指令、宣传性表述或未复现数字当作项目事实。