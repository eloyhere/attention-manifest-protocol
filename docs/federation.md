# Federation Profile

**状态**：设计稿（v0.1）。目标：让一个域能安全地接收并使用另一个域的 Manifest，而不必信任对方的服务器。

## 1. 为什么需要它

签名解决了「字节没被改」。它没解决三个跨域问题：

1. **密钥从哪来？** 接收方需要签发者的公钥，且必须能撤销。
2. **谁背书？** 签名只证明密钥控制；它不证明「这个 Agent 值得信任」。第三方证明（registry / 组织 / 客户）是另一回事。
3. **过期与重放。** 一个合法签名的旧 Manifest 可以被重放；TTL 与撤销列表必须随包传输。

## 2. 两个对象

### `ManifestBundle`

```json
{
  "amp": "0.1",
  "kind": "bundle",
  "manifest": { "…": "完整的 Manifest（已签名）" },
  "keys": [{ "kid": "a.gamma#1", "alg": "ed25519", "publicKey": "base64url…" }],
  "revoked": ["a.gamma#0"],
  "issued": "2026-10-24T07:00:00Z",
  "expires": "2026-10-25T07:00:00Z",
  "digest": "sha256:…"
}
```

- `digest` 覆盖 `manifest + keys + revoked + issued + expires`（不含自身与 `attestations`）。
- `keys` 只携带验证该 Manifest 所需的最小集合，不是密钥服务器。
- `revoked` 是**该域当前已知**的撤销集合；接收方仍需与自己的撤销策略合并。

### `Attestation`

```json
{
  "amp": "0.1",
  "kind": "attestation",
  "id": "at.7",
  "issuer": { "kind": "org", "id": "org.acme" },
  "subject": { "kind": "manifest", "id": "a.gamma", "digest": "sha256:…" },
  "scope": ["reviewed", "read-only-ok"],
  "issued": "2026-10-24T07:00:00Z",
  "expires": "2027-01-24T07:00:00Z",
  "signatures": [{ "role": "org", "alg": "ed25519", "kid": "org.acme#2", "sig": "base64url…" }]
}
```

**证明绑定的是摘要，不是名字或版本。** 这是关键：名字可以被重指，版本可以被复刻，摘要不会。

## 3. 导入流程（接收方）

```
1. 校验 bundle.digest 与内容一致            → 否则 fail closed
2. 校验 bundle.expires 未过期                → 否则 fail closed
3. 在 bundle.keys 中找 manifest 签名的 kid   → 找不到则拒绝
4. kid 在 bundle.revoked 或本地撤销表中      → 拒绝
5. 用公钥验证 manifest 签名                  → 失败则拒绝
6. 若策略要求背书：找一条 attestation，
   subject.digest == manifest.digest          → 否则降级为「未背书」
7. 记录导入事件（谁、何时、哪个摘要、哪条路径）
```

任何一步失败都**不降级信任**，而是拒绝导入。降级只能发生在第 6 步，且必须显式标注。

## 4. 不变量

| 编号 | 不变量 |
| --- | --- |
| **F-1** | bundle 摘要覆盖 manifest 与 keys；不一致即拒绝 |
| **F-2** | 撤销优先于签名：被撤销的 kid 即使签名有效也不通过 |
| **F-3** | 证明绑定摘要；摘要不匹配的证明不得用于提升信任 |
| **F-4** | 过期即失效；时钟偏差默认容忍 ±5 分钟，且必须记录 |
| **F-5** | 导入是声明，不是静默合并：必须留下事件与来源 |

## 5. 检查计划

| # | 场景 | 期望 |
| --- | --- | --- |
| F1 | 正常导出 → 导入 | 成功，摘要一致 |
| F2 | 篡改 bundle 内的 keys | 摘要校验失败 |
| F3 | 篡改 manifest 字段 | 签名校验失败 |
| F4 | 撤销 kid | 拒绝，即使签名有效 |
| F5 | bundle 过期 | 拒绝 |
| F6 | 证明摘要不匹配 | 不提升信任，标注未背书 |
| F7 | 没有钥匙 | 拒绝并说明缺哪个 kid |
| F8 | 重复导入同一摘要 | 幂等，不产生第二个事件 |

## 6. 与已有零件的关系

- [`sign.ts`](../src/manifest/sign.ts) 提供 Manifest 签名与注册表；
- `bundle` 是**传输形态**，不是新的信任根；
- 第三方证明不替代签名，只补充「谁审过」；
- 跨域交换的审计记录复用 `Receipt` 与事件日志。
