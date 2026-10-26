/**
 * End-to-end reference scenario: one incident, traced across both ledgers.
 *
 * Run: node src/cycle/demo.ts > docs/examples/runtime-run.json
 * The emitted array is validated by `npm run validate`.
 */
import type { EvidenceItem } from '../warrant/epistemic.ts'
import type { Candidate } from '../attention/attention.ts'
import { digestOf } from '../semantic/canonical.ts'
import { ExecProfile } from '../execution/exec.ts'
import { McpClient } from '../module/mcp/client.ts'
import { DemoServer } from '../module/mcp/server.ts'
import { MemoryTransport } from '../module/mcp/transport.ts'
import { AmpRuntime } from './runtime.ts'
import { generateSigningKey, signManifest } from '../manifest/sign.ts'

const runtime = new AmpRuntime({
  agentId: 'a.gamma',
  agentName: 'Gamma',
  role: 'on-call analyst',
  values: [
    { id: 'v.honesty', statement: '不确定时明确说明，不把假设包装成结论', weight: 0.95 },
  ],
  constraints: [
    { id: 'c.no_irreversible', statement: '未经确认不执行不可回滚操作', enforcement: 'hard' },
  ],
  capabilities: [
    {
      id: 'logs.query',
      label: '查询日志',
      kind: 'tool',
      confidence: 0.92,
      tier: 'T2',
      cost: { tokens: 400, ms: 900, calls: 1 },
      limits: ['仅最近 30 天', '不支持正则'],
    },
    {
      id: 'metrics.query',
      label: '查询指标',
      kind: 'tool',
      confidence: 0.88,
      tier: 'T2',
      cost: { tokens: 260, ms: 400, calls: 1 },
      limits: ['1 分钟粒度'],
    },
  ],
})

/* 1. 把「不知道」变成对象 */
const { unknown } = runtime.noteUnknown({
  question: '错误率上升是发布引起还是流量引起？',
  importance: 0.9,
  blocking: true,
  resolveCost: { calls: 4, ms: 900_000 },
})

/* 2. 第一次注意：三个候选，一个被看见，一个被拒绝，一个被刻意忽略 */
const firstCandidates: Candidate[] = [
  {
    target: { kind: 'unknown', id: unknown.id },
    role: 'question',
    tier: 'T0',
    voi: 0.88,
    goalFit: 0.95,
    uncertainty: 0.9,
    novelty: 0.6,
    costTokens: 600,
    risk: 0.1,
    trustCap: 0.95,
    why: '错误率与发布时间的相关性会决定回滚还是扩容',
  },
  {
    target: { kind: 'tool', id: 'logs.query' },
    role: 'tool',
    tier: 'T2',
    voi: 0.55,
    goalFit: 0.8,
    uncertainty: 0.6,
    novelty: 0.3,
    costTokens: 400,
    risk: 0.1,
    trustCap: 0.95,
    why: '唯一能验证时间段内错误分布的来源',
  },
  {
    target: { kind: 'concept', id: 'c.dns_failover' },
    role: 'concept',
    voi: 0.15,
    goalFit: 0.3,
    uncertainty: 0.5,
    novelty: 0.2,
    costTokens: 200,
    risk: 0,
    trustCap: 0.9,
    why: '错误码中出现 DNS 相关项时才相关',
  },
]

const firstFrame = runtime.attend(firstCandidates, 4000, 'triage')

/* 3. 通过 MCP 执行：5000 token 的结果变成句柄，不截断 */
const server = new DemoServer()
const client = new McpClient(new MemoryTransport((request) => server.handle(request)))
const exec = new ExecProfile(client, {
  budget: { calls: 20, ms: 600_000 },
  handles: runtime.handles,
  now: () => runtime.nowIso(),
  maxResultTokens: 1200,
  requireApproval: true,
  onReceipt: (receipt) => runtime.ledger.receipts.push(receipt),
})

const catalog = await exec.connect()
const action = await exec.call(
  'logs.query',
  { window: 'post' },
  { budgetTokens: 1200, predictedVoi: 0.55, realizedVoi: 0.61 },
)

/* 4. 把观察变成一条有 tier、有反证条件的主张 */
const evidence: EvidenceItem[] = [
  {
    id: 'ev.1',
    kind: 'observation',
    trust: 'self',
    independence: 0.9,
    entails: true,
    origin: 'logs.query@run.1',
    at: new Date(Date.parse('2026-10-24T01:12:41Z')).toISOString(),
    excerpt: '发布窗口内 5xx 占比 6.1%，前一窗口 0.4%',
  },
  {
    id: 'ev.2',
    kind: 'testimony',
    trust: 'trusted',
    independence: 0.4,
    origin: 'u.li@chat',
    at: new Date(Date.parse('2026-10-24T01:14:02Z')).toISOString(),
    excerpt: '发布后看起来就不对了',
  },
]

const claimResult = runtime.noteClaim({
  statement: '01:04 的发布导致错误率上升',
  tier: 'T2',
  claimScope: 'interventional',
  evidence,
  inference: 'abduction',
  auxiliaryAssumptions: ['发布窗口内无其他配置变更', '指标采集未中断'],
  causal: {
    assignment_mechanism: 'natural_experiment',
    identification_strategy: 'difference_in_differences',
    identifying_assumption: '无发布时两组趋势平行',
    adjustment_set: ['service', 'region', 'hour_of_day'],
    dag_digest: digestOf({ dag: 'deploy -> error_rate' }),
  },
  wouldBeFalseIf: '回滚后错误率不下降，或发布前错误率已同幅度上升',
  checkRunId: 'run.1',
  looks: 2,
  scope: '2026-10-24 01:00–01:30，prod-cn-east',
  baseRate: { value: 0.55, source: '过去 12 个月的 47 次同类事件' },
  alternatives: [
    {
      statement: '流量突增导致连接池耗尽',
      confidence: 0.2,
      reason_rejected: 'QPS 与昨日同期持平',
    },
  ],
})

/* 5. 一个可证伪的假设，预注册在数据访问之前 */
const hypothesisResult = runtime.noteHypothesis({
  statement: '错误率上升由 01:04 的发布引入',
  question: { kind: 'unknown', id: unknown.id },
  prediction: '回滚后 5 分钟内错误率回到基线 ±10%',
  refutesIf: '回滚完成 10 分钟后错误率仍高于基线 3 倍',
  auxiliaryAssumptions: ['日志保留 30 天', '指标口径未变'],
  prereg: {
    hash: digestOf({ hypothesis: 'deploy causes error rate', metric: '5xx_rate' }),
    registered_at: new Date(Date.parse('2026-10-24T01:16:00Z')).toISOString(),
    metric: '5xx_rate',
    stopping: 'fixed_n_10m',
    exclusions: [],
    looks: 2,
  },
})

/* 6. 目标、计划、放弃条件 */
const goal = runtime.noteGoal({
  statement: '在 10:00 前把错误率恢复到基线',
  value: 0.9,
  priority: 1,
  success: [
    { id: 'c1', statement: '5xx rate < 0.5% 持续 10 分钟', check: 'metrics.query', kind: 'query' },
  ],
})

const planResult = runtime.plan(goal, {
  budget: { calls: 8, ms: 1_800_000 },
  commitmentWindow: 1,
  edges: [['t1', 't2']],
  rollback: '保留上一版本镜像与数据库向后兼容',
  abandonIf: [
    {
      id: 'a1',
      statement: '回滚 10 分钟后错误率仍高于基线 3 倍',
      check: 'metrics.query',
      kind: 'query',
    },
  ],
  tasks: [
    {
      id: 't1',
      intent: '对比发布前后两个窗口的错误分布',
      actor: 'tool',
      ref: { kind: 'tool', id: 'logs.query' },
      pre: ['日志可用', '已获得时间窗口'],
      expect: { observation: '两个窗口的 5xx 计数', check: 'logs.query' },
      irreversibility: 0,
      status: 'done',
    },
    {
      id: 't2',
      intent: '回滚到上一版本',
      actor: 'self',
      pre: ['t1 支持发布为因'],
      expect: { observation: '版本号回到 v41 且错误率下降', check: 'metrics.query' },
      irreversibility: 2,
      status: 'pending',
    },
  ],
})

/* 7. 第二次注意：证据进入焦点，另一个候选被延后 */
const secondFrame = runtime.attend(
  [
    {
      target: { kind: 'claim', id: claimResult.claim?.id ?? 'cl.1' },
      role: 'evidence',
      tier: 'T2',
      voi: 0.4,
      goalFit: 0.95,
      uncertainty: 0.3,
      novelty: 0.1,
      costTokens: 320,
      risk: 0,
      trustCap: 0.95,
      why: '已验证的相关性支持回滚决策',
    },
    {
      target: { kind: 'hypothesis', id: hypothesisResult.hypothesis?.id ?? 'h.1' },
      role: 'question',
      tier: 'T1',
      voi: 0.3,
      goalFit: 0.7,
      uncertainty: 0.5,
      novelty: 0.2,
      costTokens: 200,
      risk: 0,
      trustCap: 0.9,
      why: '回滚后用于验证或推翻假设',
    },
    {
      target: { kind: 'concept', id: 'c.dns_failover' },
      role: 'concept',
      voi: 0.05,
      goalFit: 0.2,
      uncertainty: 0.4,
      novelty: 0.1,
      costTokens: 200,
      risk: 0,
      trustCap: 0.9,
      why: '错误码中没有 DNS 相关项，暂不相关',
    },
  ],
  4000,
  'exploit',
)

/* 8. 反思与自述：Manifest 用真实 Ed25519 签名，不再有占位符 */
const reflection = runtime.reflect()
const signingKey = await generateSigningKey('a.gamma#1')
const { digest: _digest, signatures: _signatures, ...unsignedManifest } = runtime.manifest()
const manifest = await signManifest(unsignedManifest, signingKey)

const artifacts = [
  manifest,
  unknown,
  ...(claimResult.claim ? [claimResult.claim] : []),
  ...(hypothesisResult.hypothesis ? [hypothesisResult.hypothesis] : []),
  goal,
  ...(planResult.plan ? [planResult.plan] : []),
  firstFrame.frame,
  secondFrame.frame,
  firstFrame.receipt,
  secondFrame.receipt,
  ...(action.receipt ? [action.receipt] : []),
  ...(claimResult.receipt ? [claimResult.receipt] : []),
  ...(hypothesisResult.receipt ? [hypothesisResult.receipt] : []),
  ...(planResult.receipt ? [planResult.receipt] : []),
  reflection.receipt,
]

console.error(
  [
    `frames: ${runtime.ledger.frames.length}`,
    `receipts: ${runtime.ledger.receipts.length}`,
    `claims: ${runtime.ledger.claims.length}`,
    `mcp tools: ${catalog.tools.length}`,
    `handle: ${action.handle ?? 'inline'}`,
    `voi_mae: ${reflection.mae}`,
    `audit: ${runtime.audit().length === 0 ? 'clean' : runtime.audit().join('; ')}`,
  ].join('  |  '),
)

console.log(JSON.stringify(artifacts, null, 2))
