import "./style.css";
import { createAttention, mount, compileContext } from "./attention.ts";
import type { AttentionObject, AttentionScope } from "./attention.ts";

const app = document.getElementById("app");
if (app === null) { throw new Error("Missing #app"); }
const scope: AttentionScope = { tenantId: "demo", principalId: "local", sessionId: "demo-session", turnId: "demo-turn" };
const now = new Date().toISOString();
const expiresAt = new Date(Date.now() + 3600000).toISOString();
const objects: AttentionObject[] = [
    ["goal", "Goal", "Verify the requested result against the current acceptance contract."],
    ["file", "File", "Read a versioned file slice before making an edit."],
    ["tool", "Tool", "Discover a permitted tool and inspect its pinned schema."],
].map(([id, kind, summary]) => {
    const object = createAttention({ id, summary, pointer: { id, kind, version: "1" }, scope,
        budget: { tokens: 5000, bytes: 5000 }, expiresAt, reason: "Local context compiler demonstration" }, now);
    return mount(object, { expectedVersion: object.version, now, reason: "Current task" });
});
app.innerHTML = `<header><h1>Agent framework · Context compiler</h1>
<p class="muted">Local deterministic demonstration. No model, remote tool or external service is called.</p></header>
<section class="panel"><label>Context budget (UTF-8 bytes): <input id="budget" type="number" min="0" max="20000" value="1500"></label>
<p id="metrics"></p><h2>Compiled model payload</h2><pre id="payload"></pre>
<h2>Exclusions kept outside the model payload</h2><pre id="exclusions"></pre></section>`;
const budgetInput = document.querySelector<HTMLInputElement>("#budget");
const payload = document.querySelector<HTMLElement>("#payload");
const exclusions = document.querySelector<HTMLElement>("#exclusions");
const metrics = document.querySelector<HTMLElement>("#metrics");
const render = (): void => {
    if (!budgetInput || !payload || !exclusions || !metrics) { return; }
    const bytes = Math.max(0, Math.min(20000, Number(budgetInput.value) || 0));
    const result = compileContext(objects, { scope, now: new Date().toISOString(), budget: { bytes, tokens: bytes }, currentVersion: () => "1" });
    payload.textContent = result.text || "No item fits this budget.";
    exclusions.textContent = JSON.stringify(result.exclusions, null, 2);
    metrics.textContent = `${result.items.length} selected · ${result.exclusions.length} excluded · ${result.usage.bytes} bytes · token count uses a conservative byte estimate`;
};
budgetInput?.addEventListener("input", render);
render();
