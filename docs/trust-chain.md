# 信任链（Trust Chain）

**状态**：已实现并通过跨域实测。本文说明「一个域如何判断另一个域的 Agent 可信」，以及每一环由什么保证、哪里仍然薄弱。

## 1. 五环

```
发现            签名             密钥来源          背书              授权
Agent Card  →  card signature  →  bundle keys  →  attestation   →  scope policy
```

| 环 | 问题 | 实现 | 失败时 |
| --- | --- | --- | --- |
| **发现** | 对端是谁、在哪 | `fetchAgentCard` 读 `/.well-known/agent-card.json` | 无卡片 / 无名 / 无端点 → 拒绝 |
| **签名** | 卡片有没有被改 | `card-sign.ts`：JWS JSON，EdDSA over JCS | 篡改或错键 → 拒绝 |
| **密钥来源** | 用谁的钥匙验 | `registryFromBundle`：bundle 的 `keys`，减去 `revoked` | 缺钥匙或已撤销 → 拒绝 |
| **背书** | 谁审过这份能力声明 | `verifyAttestationWithKey`：attestation 绑定 manifest 摘要，由 issuer 密钥签名 | issuer 不受信或签名无效 → 拒绝 |
| **授权** | 允许做什么 | `TrustPolicy.requiredScopes` ⊆ 已签名 attestation 的 scope | 缺 scope → 拒绝 |

一条调用即可完成五环：`fetchTrustedAgent(base, { bundle, policy, issuerKeys })`。

## 2. 信任的对象不同，不要混

这是最容易出错的一点：

| 对象 | 绑定什么 | 证明什么 |
| --- | --- | --- |
| **卡片签名** | 卡片的 JCS 序列化 | 「这个端点与能力声明没被改」 |
| **attestation** | **manifest 摘要** | 「某个组织审过这份能力声明」 |
| **bundle** | manifest + keys + 撤销 + 有效期 | 「这些字节是一起发布的」 |

背书针对 manifest，而不是卡片；卡片密钥的连续性由签名单独保证。两者都通过，才构成完整判断。

## 3. 三条不变量

1. **不采信卡片自带的公钥**：验签只查本地注册表；bundle 只负责填充注册表。
2. **未知 issuer 不降级**：缺 issuer 密钥是拒绝，不是「无背书但可用」。
3. **撤销优先**：bundle 声明撤销的 kid，即使签名有效也不通过。

## 4. 实测覆盖

| 场景 | 结果 |
| --- | --- |
| 域 A 背书、域 B 出示卡片 | 通过，端点被解析 |
| 通过后发送 A2A `message/send` | 域 B 接收委派 |
| 缺少 required scope | 拒绝，理由明确 |
| issuer 密钥不在本地信任表 | 拒绝，不静默忽略 |
| 卡片被篡改 / kid 被撤销 | 拒绝 |

测试：`tools/trust-flow-check.ts`（4 项）、`tools/card-sign-check.ts`（4 项）、`tools/card-trust-check.ts`（4 项）、`tools/bundle-trust-check.ts`（3 项）。

## 5. 缺口（诚实清单）

- **没有密钥发现协议**：`issuerKeys` 与 bundle 都由调用方提供，没有 jwks / did:web 自动解析。
- **没有撤销新鲜度**：bundle 里的撤销列表是一次快照，没有「多久必须刷新」的约束。
- **没有策略语言**：只有 `requiredScopes` 的白名单；没有「金额上限」「只读」「租户」这类条件。
- **跨域限于本机**：两个域都在 localhost，没有连过真实第三方 Agent。
- **卡片签名在 A2A 中是可选**：对端若不签名，本实现只能拒绝，没有降级路径。

## 6. 与其它文档的关系

- 协议对象见 [`docs/architecture.md`](architecture.md) §9（他者）与 §11（安全）；
- 跨域对象（bundle / attestation）见 [`docs/federation.md`](federation.md)；
- 多 Agent 协作与委派见 [`docs/multi-agent.md`](multi-agent.md)；
- 研究依据见 [`docs/research/team-cognition.md`](research/team-cognition.md) 与 [`docs/research/delegation-and-interop.md`](research/delegation-and-interop.md)。
