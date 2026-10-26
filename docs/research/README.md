# 研究档案（Research）

这八份简报是 [`docs/architecture.md`](../architecture.md) 与 [`docs/rationale.md`](../rationale.md) 的证据底座。每份都标注了来源与可信度；**厂商数字、论文模拟、独立评测被分开标注**，不混为一谈。

| 文件 | 支撑的章节 | 三个要点 |
| --- | --- | --- |
| [attention-economics.md](attention-economics.md) | §5 注意力层 | VOI/EVSI 公式；批处理有随机田野实验支持（n=237）；「23 分钟」是误传 |
| [caching-and-tool-search.md](caching-and-tool-search.md) | §5.8 / §10.6 | 缓存链 `tools → system → messages`；延迟加载的工具被排除在前缀外；72K→8.7K |
| [cognitive-architectures.md](cognitive-architectures.md) | §2 / §3 | 只有四个原语是共通的；`ignored[]` 没有直接先例；僵局分类 |
| [concepts-and-belief-revision.md](concepts-and-belief-revision.md) | §6.5 / §2.5 | 熵序收缩可落地；BeliefBank 是最近先例；格式变化能摆动 76 个点 |
| [metacognition-and-calibration.md](metacognition-and-calibration.md) | §8.4 / §8.6 | ECE 0.05–0.25；内省最好约 20%；沙袋与迎合可被激励 |
| [other-minds.md](other-minds.md) | §9 | 高阶信念 73.5%→20%；显式结构 +51%；提问时机曲线 |
| [retrieval-and-gating.md](retrieval-and-gating.md) | §5.4 | R@10 约 42–45%；top-5 覆盖 64.7%；弃权必须是一等输出 |
| [warrant-and-provenance.md](warrant-and-provenance.md) | §6.2 / §6.4 | PROV 记录派生而非支持；引用召回 51.5%；按来源根去重算 `n_eff` |

## 引用纪律

以下三条是写作时**主动删除**的常见说法，留此备案：

1. **「一次打断需要 23 分钟恢复」** —— 不成立。常被引用的 Mark, Gudith & Klocke (2008) 实际结论是：被打断的任务完成得**更快**、质量无损失，但压力与挫败感更高；全文没有 23 分钟这个数字。该数字是媒体转述的产物。
2. **「Hudson et al., Would you learn to live with a 5-second delay?」** —— 不存在。OpenAlex / Crossref / 公开网络均无匹配；最接近的真实工作是 NotiModes（MuC 2020）。
3. **「TOON 比 JSON 省 30–60% token」** —— 只在对比「美化格式的 JSON」时成立。独立评测显示相对紧凑 JSON 的节省有限，且伴随准确率损失（约 −9pp）；因此 AMP 不把 TOON 设为默认编码。

## 读法

先读 [attention-economics.md](attention-economics.md) 与 [retrieval-and-gating.md](retrieval-and-gating.md) 理解「注意力为什么稀缺、检索为什么是天花板」；再读 [metacognition-and-calibration.md](metacognition-and-calibration.md) 与 [other-minds.md](other-minds.md) 理解「为什么不能相信自述、他者模型为什么要限深」。
