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

interface Condition {
    id: string;
    label: string;
    inputTokens: number;
    summary: { text: string; layer: string | null; expectedLayer: string; latencyMs: number };
    detail: { text: string; pid: string | null; lock: string | null; expectedPid: string; expectedLock: string; latencyMs: number; toolCalls: string[] };
}

interface VizData {
    generatedAt: string;
    model: string;
    context: { nodes: number; viewTokens: number; flatTokens: number; refs: number; budgetTokens: number };
    conditions: Condition[];
    tree: AstNode[];
    edges: Array<{ from: string; to: string; kind: string }>;
    details: Record<string, string>;
}

const data = raw as unknown as VizData;
const app = document.getElementById("app");
if (app === null) throw new Error("missing #app");

const money = (value: number): string => value.toLocaleString("en-US");
const escapeHtml = (value: string): string =>
    value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character);

const conditionRows = data.conditions
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

const treeRows = data.tree
    .map(
        (node) => `<button class="node ${node.detailRef === undefined ? "summary-only" : ""}" data-node="${escapeHtml(node.id)}" style="--depth:${node.depth}">
            <span class="kind">${escapeHtml(node.kind)}</span>
            <span class="id">${escapeHtml(node.id)}</span>
            <span class="summary">${escapeHtml(node.summary)}</span>
            <span class="ref">${node.detailRef === undefined ? "summary" : "detail ↗"}</span>
        </button>`,
    )
    .join("");

const architecture = [
    { layer: "CAS", role: "sha256 detail store", state: "active" },
    { layer: "Exact map", role: "nodeId -> node", state: "active" },
    { layer: "LRU", role: "resident detail cache", state: "active" },
    { layer: "AST", role: "tree + precedence", state: "active" },
    { layer: "Bloom", role: "negative CAS lookup", state: "deferred" },
    { layer: "Cuckoo", role: "deletable hot set", state: "deferred" },
    { layer: "Stack", role: "DFS / rollback", state: "planned" },
    { layer: "Heap", role: "top-k salience", state: "planned" },
];

const architectureRows = architecture
    .map(
        (item) => `<div class="layer ${item.state}">
            <span class="layer-name">${escapeHtml(item.layer)}</span>
            <span class="layer-role">${escapeHtml(item.role)}</span>
            <span class="layer-state">${item.state}</span>
        </div>`,
    )
    .join("");

app.innerHTML = `
<header>
  <h1>AMP Context AST</h1>
  <p class="muted">${escapeHtml(data.model)} · ${escapeHtml(data.generatedAt)} · summaries in prompt, details local</p>
</header>

<section class="metrics">
  <div><span class="label">nodes</span><b>${data.context.nodes}</b></div>
  <div><span class="label">summary tokens</span><b>${money(data.context.viewTokens)}</b></div>
  <div><span class="label">flat tokens</span><b>${money(data.context.flatTokens)}</b></div>
  <div><span class="label">detail refs</span><b>${data.context.refs}</b></div>
  <div><span class="label">budget</span><b>${money(data.context.budgetTokens)}</b></div>
</section>

<section class="panel">
  <h2>Context layers</h2>
  <p class="muted">Bloom/Cuckoo are index filters, not storage. They stay deferred until negative lookups or deletions are a measured bottleneck.</p>
  <div class="layers">${architectureRows}</div>
</section>

<section class="panel">
  <h2>Real DeepSeek A/B</h2>
  <p class="muted">Same incident. Flat includes all details; AST sends summaries only; AST+tool calls read_detail on demand.</p>
  <table>
    <thead><tr><th>condition</th><th>input tokens</th><th>layer</th><th>blocking pid</th><th>lock</th><th>tool calls</th></tr></thead>
    <tbody>${conditionRows}</tbody>
  </table>
  <div class="verdict">
    <b>AST summary</b> keeps the layer answer but cannot answer the detail question.
    <b>AST + read_detail</b> recovers the detail with roughly ${
        data.conditions[0].inputTokens > 0 ? `${Math.round((data.conditions[2].inputTokens / data.conditions[0].inputTokens) * 100)}%` : "?"
    } of the flat input tokens.
  </div>
</section>

<section class="grid">
  <div class="panel tree-panel">
    <h2>Tree + precedence</h2>
    <p class="muted">${data.tree.length} nodes · ${data.edges.length} edges · click a node</p>
    <div class="tree">${treeRows}</div>
  </div>
  <div class="panel detail-panel">
    <h2>Local detail</h2>
    <div id="detail-meta" class="muted">select a node</div>
    <pre id="detail">—</pre>
    <h3>Precedence sample</h3>
    <ul id="edges" class="edges">${data.edges
        .slice(0, 12)
        .map((edge) => `<li>${escapeHtml(edge.from)} <span class="muted">--${escapeHtml(edge.kind)}--&gt;</span> ${escapeHtml(edge.to)}</li>`)
        .join("")}</ul>
  </div>
</section>

<footer class="muted">Generated by tools/context-ast-deepseek.ts. This page is a view over the report; it does not call the model.</footer>
`;

const detailEl = document.getElementById("detail");
const metaEl = document.getElementById("detail-meta");
const selectNode = (id: string): void => {
    const node = data.tree.find((entry) => entry.id === id);
    if (node === undefined || detailEl === null || metaEl === null) return;
    const detail = data.details[id];
    metaEl.textContent = `${node.id} · ${node.kind} · ${node.detailRef ?? "summary only"}`;
    detailEl.textContent = detail ?? node.summary;
    for (const button of document.querySelectorAll<HTMLButtonElement>(".node")) button.classList.toggle("active", button.dataset.node === id);
};
for (const button of document.querySelectorAll<HTMLButtonElement>(".node")) {
    button.addEventListener("click", () => selectNode(button.dataset.node ?? ""));
}
selectNode("layer.database.probe.3");
