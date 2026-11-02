# `search/projection.ts` 输入边界审计

> 修复复核：下文保留独立审计时的复现。主线程已校验可选 projectId/revision/sourceUri 与 tags/searchTerms 的形状，并在读取任何输入字段前进行 descriptor-safe JSON 复制。getter 探针现在断言调用次数为 0；元数据畸形输入现在断言抛错。新增投影 13/13 与既有投影 7/7 通过。opaque ID 长度与 unresolved 外部关系仍为兼容性策略项；发现阶段不将 foreign composite key 回退为本地 raw ID。最终联合结果见 `boundary-joint-zh.md`。

范围仅限 `src/search/projection.ts` 的输入、重复/合并、关系目标、JSON-safe copy、禁用记录、ID 与 namespace 边界。未修改实现或其他既有文件。对抗检查新增于 `tools/boundaryProjectionCheck.ts`；既有通过覆盖来自 `tools/searchProjectionCheck.ts`。

## Findings

### MEDIUM: CatalogRecord 可选字段及字符串数组缺少校验

**位置：** `src/search/projection.ts:86-92`；收尾仅在 `196-201` 校验关系字符串和整体 JSON 值。

**最小复现：**

```ts
projectSearchRecords({
  namespace: "audit",
  records: [{
    id: "x", kind: "custom", name: "x", summary: "",
    projectId: "", revision: " ", sourceUri: "",
    tags: [42] as unknown as string[],
    searchTerms: [null] as unknown as string[],
    payload: {},
  }],
});
```

调用成功并原样返回空 `projectId`、空 `sourceUri`、数字 tag 和 null searchTerm。必需 `id/kind/name` 及顶层 `namespace/revision` 有非空检查，但 generic `CatalogRecord` 的可选作用域/来源字段和字符串数组元素没有；`summary` 只检查类型。这会把 schema-invalid 字段传入持久层/下游索引，也可能造成 scope metadata 语义不一致。

**建议：** 在 `put` 中验证可选文本字段的非空性及 `tags/searchTerms` 为字符串数组；`summary` 若允许空则只校验 string。

### LOW: 领域输入 accessor 会在被拒绝前执行

**位置：** `src/search/projection.ts:134-147`，尤其第 146 行读取 `item.purpose` 生成 `searchTerms`，第 147 行才通过 `payloadOf(item)` 检查 accessor。

**最小复现：**

```ts
let calls = 0;
const host = { id: "x", kind: "plugin", name: "x", description: "d" };
Object.defineProperty(host, "purpose", {
  enumerable: true,
  get() { calls++; return "side effect"; },
});
projectSearchRecords({ namespace: "audit", host: [host] });
// 抛 TypeError: projection payload has an accessor，但 calls === 1
```

`payloadOf(item)` 最终拒绝 accessor，没有把 getter 结果持久化，但拒绝前已经触发外部副作用。普通注册路径应已验证/克隆字段，因此实际暴露依赖调用方是否绕过 registry 直接传入结构化输入；仍建议先对原始来源做 descriptor 检查/安全复制，再读取字段。

### LOW / POLICY: namespace key 语法与关系目标不绑定当前 namespace

**位置：** namespace 仅由 `nonempty` 校验（`77`）；generic 关系目标只要求非空（`196-200`）；`relatedIds`、未知 workspace target 也会保留裸 ID（`124-127`、`136`）。

**最小复现：**

```ts
const foreign = catalogKey("another-namespace", "skill", "s");
projectSearchRecords({
  namespace: "audit",
  records: [{ id: "holder", kind: "custom", name: "h", summary: "", payload: {},
    relations: [{ relation: "ref", targetId: foreign }] }],
});
```

结果接受外部 namespace 的复合 key；超长（例如 200 KB）的 namespace、ID、relation 和 target 字符串也会被投影接受。当前 `CatalogRecord` 注释明示 relation target 可 unresolved，`relatedIds` 亦可能不是类型化目标；因此不能仅据此判为 bug。若合同要求关系只能在当前 namespace 解析，则须在 projection 或 persistence 边界拒绝/标记外部 key；否则建议给长度设上限，以控制 SQLite payload 与 ES 文档生成成本。

## 通过覆盖

- **Namespace/ID tuple 编码：** `catalogKey` 对 delimiter、NUL、引号、斜线、Unicode 组合保持区分；同 ID 的不同 kind 可并存。由新增对抗用例覆盖。
- **必需标识：** 空白 namespace/revision 和空白 record ID/kind/name 会拒绝；超长/空白包裹的 ID 当前被接受，是上面的约束策略项。
- **预期重复合并：** workspace project + HostProject 及 HostComponent + environment 按固定来源顺序合并；project ownership 冲突拒绝；同来源重复、跨源非预期冲突拒绝。既有和新增检查覆盖。
- **关系类型化：** `skillIds/knowledgeIds/toolIds/protocolIds` 生成当前 namespace + kind 的 key；workspace 已知 parent 转复合 key，未知目标保留裸 ID；未知关系 source 拒绝。既有测试覆盖。
- **JSON-safe copy：** cycle、class instance、symbol keys、accessor、NaN/Infinity/BigInt、array undefined 与 sparse array 拒绝；普通对象字段 `undefined` 按有意规则递归移除。`__proto__` 作为数据键保留而不篡改对象原型；共享引用被复制为分离对象；结果修改不影响输入。既有及新增测试覆盖。
- **禁用过滤：** 显式 disabled skill/protocol 与 generic 对应 payload 被过滤；enabled/default skill、active/deprecated protocol 保留。既有及新增测试覆盖。

## 验证

运行命令：

```powershell
R:\nodejs\node.exe --test tools/boundaryProjectionCheck.ts tools/searchProjectionCheck.ts
```

结果：**20 项通过，0 失败**（新增边界用例 13 项，既有投影用例 7 项）。