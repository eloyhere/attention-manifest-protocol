#!/usr/bin/env node
/**
 * Live end-to-end runtime check against DeepSeek.
 *
 * One task, one model call, kernel lease + receipt + runtime.turn object.
 * Requires DEEPSEEK_API_KEY. Not part of CI/verify.
 */
import { Database } from "../src/database/service/database.ts";
import { AgentService } from "../src/process/index.ts";
import { spawnThread } from "../src/thread/thread.ts";
import { Kernel } from "../src/kernel/index.ts";
import { DeepSeekLlm } from "../src/module/llm/deepseek.ts";
import { CognitiveRuntime } from "../src/runtime/cognitiveRuntime.ts";
import { KernelRuntime } from "../src/runtime/kernelRuntime.ts";

const At = new Date().toISOString();

const db = new Database(":memory:");
const agent = db.processService.create({ id: "a.live.runtime", name: "Live Runtime Agent", budget: { calls: 10, tokens: 20_000 } }, At);
const service = new AgentService(db.adapters.agents, db.adapters.social);
service.createAgent({
    pid: agent.pid,
    id: "a.live.runtime",
    name: "Live Runtime Agent",
    values: ["truth", "care"],
    constraints: ["do not fabricate evidence"],
    narrative: "I answer directly, separate evidence from inference, and do not pretend to be a therapist.",
    at: At,
});
service.addRole({
    id: "role.engineer",
    label: "Engineer",
    obligations: [{ id: "ob.reproduce", statement: "reproduce before fixing" }],
    audiences: ["team"],
    createdAt: At,
});
service.assignRole({ pid: agent.pid, roleId: "role.engineer", salience: 0.9, active: true, since: At });
service.remember({ pid: agent.pid, kind: "procedural", content: "Run the failing test before changing code.", salience: 0.9, at: At });
service.setAffect(agent.pid, { stress: 0.3, fatigue: 0.2, mood: "focused" }, At);

const work = spawnThread(
    db.db,
    {
        pid: agent.pid,
        goal: "g.live.runtime",
        statement: "answer one user question",
        success: [{ id: "c.live.runtime", statement: "answer recorded", check: "inspect" }],
    },
    At,
);

const llm = DeepSeekLlm.fromEnv();
const cognitive = new CognitiveRuntime({
    pid: agent.pid,
    agent: db.adapters.agents,
    social: db.adapters.social,
    llm,
    budgetTokens: 500,
    maxOutputTokens: 512,
});
const kernel = new Kernel(db.db, { now: () => new Date().toISOString(), leaseMs: 120_000 });
const runtime = new KernelRuntime({ kernel, cognitive });

const result = await runtime.runTask(work.tid, "My TypeScript build fails after a dependency upgrade. What should I check first?");
if (result === undefined) {
    console.error("no task was run");
    process.exitCode = 1;
} else {
    console.log(result.turn.answer);
    console.log(
        `\nstatus=${result.report.status} tokens=${result.report.usage.tokens ?? 0} input=${result.turn.usage?.inputTokens ?? 0} output=${result.turn.usage?.outputTokens ?? 0}`,
    );
    console.log(
        `scenario=${result.turn.scenario.active.join(",")} interaction=${result.turn.interaction.primary} attention=${result.turn.attention.utilization.toFixed(2)}`,
    );
    console.log(`object=${result.objectId} receipt=${result.receiptId}`);
}
kernel.close();
db.close();
