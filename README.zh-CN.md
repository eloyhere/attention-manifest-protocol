# Attention Manifest Protocol（AMP）

[English](README.md) · **简体中文**

> 让 Agent 以科学的方式认识宇宙，并把注意力用在需要的地方。

AMP 是一个**元认知协议**。它不规定模型如何思考，而规定 Agent 如何**声明**自己知道什么、想要什么、此刻在注意什么，以及在注意力有限时如何决定下一个看哪里。

它维护两个账本，回答两个不同的问题。

| 账本 | 记录 | 回答 |
| --- | --- | --- |
| **Warrant Ledger**（凭据账本） | 主张、证据、假设、未知、概念、计划 | 我凭什么相信这件事？ |
| **Attention Ledger**（注意力账本） | 注意帧、预算、回执、打断 | 我的认知花在了哪里？ |

一个控制器在两者之间做交易：用有限的注意力，换取最有价值的凭据。

## 三个对象

| 对象 | 生命周期 | 回答 |
| --- | --- | --- |
| `Manifest` | 持久、带 TTL、可签名 | 我是谁？能做什么？承诺了什么？还缺什么？ |
| `Frame` | 一次注意周期，不可变 | 此刻在看什么？为什么是它？**忽略了什么？** |
| `Receipt` | 每次行动 | 花了多少注意力？换回了什么？ |

`Frame.ignored` 是这套设计中没有直接先例的字段。经典认知架构记录了「注意到了什么」，却没有记录「刻意忽略了什么、依据是什么、何时应当重新考虑」。

## 已实现的范围

| 层 | 能力 |
| --- | --- |
| 协议 | 14 个 JSON Schema、一一对应的 TS 类型、消息信封与七种言语行为 |
| 注意力 | 显著性契约、焦点集与忽略集、僵局分类、打断分级与债务 |
| 凭据 | T0–T4 认知投入等级、置信度派生、最小修订、未知与停止规则 |
| 执行 | MCP 2026-07-28 客户端（无状态与旧式回退）、预算调度、句柄整形 |
| 联邦 | `ManifestBundle` 与 `Attestation`、摘要固定、撤销、导入失败关闭 |
| 协作 | 委派衰减、租约 fencing、任务板、结果合并与冲突裁决、统一账本 |
| 信任 | Agent Card 发现与签名、bundle 密钥、scope 策略、A2A `message/send` |
| 持久化 | 只追加哈希链、快照校验、恢复时拒收损坏数据 |

## 仓库结构

| 路径 | 内容 |
| --- | --- |
| [`docs/architecture.md`](docs/architecture.md) | 架构规范：模型、注意力、凭据、规划、协议、安全、一致性、落地 |
| [`docs/rationale.md`](docs/rationale.md) | 12 条 ADR：每条决策的证据、代价与被否决的方案 |
| [`docs/multi-agent.md`](docs/multi-agent.md) | 多 Agent：准入规则、委派对象与 10 条不变量、团队对象、8 个失败信号 |
| [`docs/trust-chain.md`](docs/trust-chain.md) | 信任链：发现 → 卡片签名 → bundle 密钥 → 背书 → scope 策略 |
| [`docs/federation.md`](docs/federation.md) | 跨域 bundle 与第三方证明 |
| [`docs/research/`](docs/research/) | 九份研究简报，含真实端点兼容性矩阵与引用纪律 |
| [`docs/schemas/`](docs/schemas/) | 14 个 JSON Schema |
| [`docs/examples/`](docs/examples/) | 33 个可校验示例：帧链、主张、计划、委派、bundle、快照 |
| [`src/types/`](src/types/) | 与 schema 一一对应的 TS 类型 |
| [`src/runtime/`](src/runtime/) | 参考运行时（见下表） |
| [`tools/`](tools/) | 29 个校验脚本、4 个示例生成器、5 个真实端点探针，全部为 TypeScript |

运行时模块：

| 模块 | 职责 |
| --- | --- |
| `runtime.ts` / `ledger.ts` | 七个动词、帧链、回执、Manifest、自审计 |
| `attention.ts` / `budget.ts` / `handles.ts` | 显著性、唯一计费点、句柄分页 |
| `warrant.ts` / `inquiry.ts` | 置信度派生、等级校验、预注册与复现 |
| `exec.ts` / `mcp/` | MCP 执行、摘要固定、审批、TTL 缓存 |
| `federation.ts` / `sign.ts` / `card-sign.ts` / `trust.ts` | 签名、bundle、证明、卡片验签、scope 策略 |
| `team.ts` / `board.ts` / `merge.ts` / `metrics.ts` / `session.ts` | 委派、任务板、合并、指标、端到端会话 |
| `channel.ts` / `http-channel.ts` / `a2a.ts` | 传输接缝、HTTP 幂等通道、A2A 绑定 |
| `persistence.ts` / `share.ts` | 哈希链快照与三种共享粒度 |

## 快速开始

```bash
npm run verify            # 29 个校验入口，外加两份类型检查（src 与 tools）
npm run scenario          # 端到端事故场景：委派 → MCP → 合并 → 注意力 → 指标
npm run demo              # 生成运行时轨迹
npm run typecheck         # src/ 的严格类型检查
npm run typecheck:tools   # tools/ 的类型检查，测试代码同样受检
```

`tools/` 下没有 JavaScript 文件。38 个脚本全部是 `.ts`，由 Node 直接做类型剥离后运行，
并纳入 `tsconfig.tools.json` 的检查范围，因此测试代码与运行时共享同一套类型契约。

真实端点（需要网络）：

```bash
npm run live-test     # context7（2026-07-28）
npm run live-legacy   # mslearn + deepwiki（旧式握手回退）
npm run oauth-probe   # Linear / Figma 的 OAuth 发现链
```

## 从哪读起

1. [`docs/architecture.md`](docs/architecture.md) §1 —— 为什么需要 AMP，附证据速览
2. §3 —— 两个账本、三类对象与 12 条不变量
3. §6 —— 凭据层：T0–T4、可证伪、认知卫生
4. §12 —— 一致性向量 V1–V15
5. [`docs/examples/frame-chain.json`](docs/examples/frame-chain.json) —— 一条真实的帧链

## 状态与边界

`v0.1.0`。14 个 schema、33 个示例对象、29 个校验入口、166 项带计数的断言，全部通过。
规范文档与研究简报目前以简体中文撰写。

**不承诺什么。** 不承诺「理解」，只承诺可声明、可计价、可反驳、可审计；不对意识问题表态。

**尚未实现。** 沙箱隔离、多租户、OAuth 交互授权，以及与真实外部 Agent 的互通；所有跨域测试均在本机运行。参考实现有意不包含生产部署所需的环境层能力。

## 文档与变更历史

- [架构规范](docs/architecture.md)
- [设计依据与 ADR](docs/rationale.md)
- [Changelog](CHANGELOG.md) · [更新日志](CHANGELOG.zh-CN.md)

## 许可

本包标记为 `UNLICENSED`：在补充许可证之前，不授予任何复用许可。
