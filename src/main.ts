import "./style.css";
import raw from "../viz/context-ast.json";

interface AstNode {
    id: string;
    parentId?: string;
    kind: string;
    summary: string;
    detailRef?: string;
    depth: number;
    order: number;
}

interface ConditionSummary {
    text: string;
    layer: string | null;
    expectedLayer: string;
    latencyMs: number;
}

interface ConditionDetail {
    text: string;
    pid: string | null;
    lock: string | null;
    expectedPid: string;
    expectedLock: string;
    latencyMs: number;
    toolCalls: string[];
}

interface Condition {
    id: string;
    label: string;
    inputTokens: number;
    summary: ConditionSummary;
    detail: ConditionDetail;
}

interface ContextMetrics {
    nodes: number;
    viewTokens: number;
    flatTokens: number;
    refs: number;
    budgetTokens: number;
}

interface AstEdge {
    from: string;
    to: string;
    kind: string;
}

interface ArchitectureLayer {
    layer: string;
    role: string;
    state: string;
}

interface VizData {
    generatedAt: string;
    model: string;
    context: ContextMetrics;
    conditions: Condition[];
    tree: AstNode[];
    edges: AstEdge[];
    details: Record<string, string>;
}

const Data: VizData = raw as unknown as VizData;
const App: HTMLElement | null = document.getElementById("app");
if (App === null) {
    throw new Error("missing #app");
}

const money: (value: number) => string = (value: number): string => value.toLocaleString("en-US");
const escapeHtml: (value: string) => string = (value: string): string =>
    value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character);

const ConditionRows: string = Data.conditions
    .map(
        (condition) => `<tr>
            <td><b>${escapeHtml(condition.label)}</b><div class="muted">${escapeHtml(condition.id)}</div></td>
            <td>${money(condition.inputTokens)}</td>
            <td>${condition.summary.layer === condition.summary.expectedLayer ? "✅" : "❌"} ${escapeHtml(condition.summary.layer ?? "null")}</td>
            <td>${condition.detail.pid === condition.detail.expectedPid ? "✅" : "❌"} ${escapeHtml(condition.detail.pid ?? "null")}</td>
            <td>${condition.detail.lock === condition.detail.expectedLock ? "✅" : "❌"} ${escapeHtml(condition.detail.lock ?? "null")}</td>
            <td>${escapeHtml(condition.detail.toolCalls.join(", ") || "none")}</td>
        </tr>`,
    )
    .join("");

const TreeRows: string = Data.tree
    .map(
        (node) => `<button class="node ${node.detailRef === (void 0) ? "summary-only" : ""}" data-node="${escapeHtml(node.id)}" style="--depth:${node.depth}">
            <span class="kind">${escapeHtml(node.kind)}</span>
            <span class="id">${escapeHtml(node.id)}</span>
            <span class="summary">${escapeHtml(node.summary)}</span>
            <span class="ref">${node.detailRef === (void 0) ? "summary" : "detail ↗"}</span>
        </button>`,
    )
    .join("");

const Architecture: ArchitectureLayer[] = [
    { layer: "CAS", role: "sha256 detail store", state: "active" },
    { layer: "Exact map", role: "nodeId -> node", state: "active" },
    { layer: "LRU", role: "resident detail cache", state: "active" },
    { layer: "AST", role: "tree + precedence", state: "active" },
    { layer: "Bloom", role: "negative CAS lookup", state: "deferred" },
    { layer: "Cuckoo", role: "deletable hot set", state: "deferred" },
    { layer: "Stack", role: "DFS / rollback", state: "planned" },
    { layer: "Heap", role: "top-k salience", state: "planned" },
];

const ArchitectureRows: string = Architecture.map(
    (item) => `<div class="layer ${item.state}">
            <span class="layer-name">${escapeHtml(item.layer)}</span>
            <span class="layer-role">${escapeHtml(item.role)}</span>
            <span class="layer-state">${item.state}</span>
        </div>`,
).join("");

App.innerHTML = `
<header>
  <h1>AMP Context AST</h1>
  <p class="muted">${escapeHtml(Data.model)} · ${escapeHtml(Data.generatedAt)} · summaries in prompt, details local</p>
</header>

<section class="metrics">
  <div><span class="label">nodes</span><b>${Data.context.nodes}</b></div>
  <div><span class="label">summary tokens</span><b>${money(Data.context.viewTokens)}</b></div>
  <div><span class="label">flat tokens</span><b>${money(Data.context.flatTokens)}</b></div>
  <div><span class="label">detail refs</span><b>${Data.context.refs}</b></div>
  <div><span class="label">budget</span><b>${money(Data.context.budgetTokens)}</b></div>
</section>

<section class="panel">
  <h2>Context layers</h2>
  <p class="muted">Bloom/Cuckoo are index filters, not storage. They stay deferred until negative lookups or deletions are a measured bottleneck.</p>
  <div class="layers">${ArchitectureRows}</div>
</section>

<section class="panel">
  <h2>Real DeepSeek A/B</h2>
  <p class="muted">Same incident. Flat includes all details; AST sends summaries only; AST+tool calls read_detail on demand.</p>
  <table>
    <thead><tr><th>condition</th><th>input tokens</th><th>layer</th><th>blocking pid</th><th>lock</th><th>tool calls</th></tr></thead>
    <tbody>${ConditionRows}</tbody>
  </table>
  <div class="verdict">
    <b>AST summary</b> keeps the layer answer but cannot answer the detail question.
    <b>AST + read_detail</b> recovers the detail with roughly ${
        Data.conditions[0].inputTokens > 0 ? `${Math.round((Data.conditions[2].inputTokens / Data.conditions[0].inputTokens) * 100)}%` : "?"
    } of the flat input tokens.
  </div>
</section>

<section class="grid">
  <div class="panel tree-panel">
    <h2>Tree + precedence</h2>
    <p class="muted">${Data.tree.length} nodes · ${Data.edges.length} edges · click a node</p>
    <div class="tree">${TreeRows}</div>
  </div>
  <div class="panel detail-panel">
    <h2>Local detail</h2>
    <div id="detail-meta" class="muted">select a node</div>
    <pre id="detail">—</pre>
    <h3>Precedence sample</h3>
    <ul id="edges" class="edges">${Data.edges
        .slice(0, 12)
        .map((edge) => `<li>${escapeHtml(edge.from)} <span class="muted">--${escapeHtml(edge.kind)}--&gt;</span> ${escapeHtml(edge.to)}</li>`)
        .join("")}</ul>
  </div>
</section>

<footer class="muted">Generated by tools/context-ast-deepseek.ts. This page is a view over the report; it does not call the model.</footer>
`;

const DetailEl: HTMLElement | null = document.getElementById("detail");
const MetaEl: HTMLElement | null = document.getElementById("detail-meta");
const selectNode: (id: string) => void = (id: string): void => {
    const node: AstNode | undefined = Data.tree.find((entry) => entry.id === id);
    if (node === (void 0) || DetailEl === null || MetaEl === null) {
        return;
    }
    const detail: string = Data.details[id];
    MetaEl.textContent = `${node.id} · ${node.kind} · ${node.detailRef ?? "summary only"}`;
    DetailEl.textContent = detail ?? node.summary;
    const buttons: HTMLButtonElement[] = [...document.querySelectorAll<HTMLButtonElement>(".node")];
    for (let i: number = 0; i < buttons.length; i += 1) {
        const button: HTMLButtonElement = buttons[i];
        button.classList.toggle("active", button.dataset.node === id);
    }
};
const Nodes: HTMLButtonElement[] = [...document.querySelectorAll<HTMLButtonElement>(".node")];
for (let i: number = 0; i < Nodes.length; i += 1) {
    const button: HTMLButtonElement = Nodes[i];
    button.addEventListener("click", () => selectNode(button.dataset.node ?? ""));
}
selectNode("layer.database.probe.3");
