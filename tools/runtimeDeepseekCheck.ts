#!/usr/bin/env node
/**
 * Live end-to-end runtime check against DeepSeek.
 *
 * One task, one model call, kernel lease + receipt + runtime.turn object.
 * Requires DEEPSEEK_API_KEY. Not part of CI/verify.
 */
import type { ProcessEntity } from "../src/database/entity/process.ts";
import { Database } from "../src/database/service/database.ts";
import { AgentService } from "../src/process/index.ts";
import type { ThreadRecord } from "../src/thread/thread.ts";
import { spawnThread } from "../src/thread/thread.ts";
import { Kernel } from "../src/kernel/index.ts";
import { DeepSeekLlm } from "../src/module/llm/deepseek.ts";
import { CognitiveRuntime } from "../src/runtime/cognitiveRuntime.ts";
import type { KernelRuntimeTurn } from "../src/runtime/kernelRuntime.ts";
import { KernelRuntime } from "../src/runtime/kernelRuntime.ts";

const At: string = new Date().toISOString();

const Db: Database = new Database(":memory:");
const Agent: ProcessEntity = Db.processService.create({ id: "a.live.runtime", name: "Live Runtime Agent", budget: { calls: 10, tokens: 20_000 } }, At);
const Service: AgentService = new AgentService(Db.adapters.agents, Db.adapters.social);
Service.createAgent({
    pid: Agent.pid,
    id: "a.live.runtime",
    name: "Live Runtime Agent",
    values: ["truth", "care"],
    constraints: ["do not fabricate evidence"],
    narrative: "I answer directly, separate evidence from inference, and do not pretend to be a therapist.",
    at: At,
});
Service.addRole({
    id: "role.engineer",
    label: "Engineer",
    obligations: [{ id: "ob.reproduce", statement: "reproduce before fixing" }],
    audiences: ["team"],
    createdAt: At,
});
Service.assignRole({ pid: Agent.pid, roleId: "role.engineer", salience: 0.9, active: true, since: At });
Service.remember({ pid: Agent.pid, kind: "procedural", content: "Run the failing test before changing code.", salience: 0.9, at: At });
Service.setAffect(Agent.pid, { stress: 0.3, fatigue: 0.2, mood: "focused" }, At);

const Work: ThreadRecord = spawnThread(
    Db.db,
    {
        pid: Agent.pid,
        goal: "g.live.runtime",
        statement: "answer one user question",
        success: [{ id: "c.live.runtime", statement: "answer recorded", check: "inspect" }],
    },
    At,
);

const Llm: DeepSeekLlm = DeepSeekLlm.fromEnv();
const Cognitive: CognitiveRuntime = new CognitiveRuntime({
    pid: Agent.pid,
    agent: Db.adapters.agents,
    social: Db.adapters.social,
    llm: Llm,
    budgetTokens: 500,
    maxOutputTokens: 512,
});
const KernelHandle: Kernel = new Kernel(Db.db, { now: () => new Date().toISOString(), leaseMs: 120_000 });
const Runtime: KernelRuntime = new KernelRuntime({ kernel: KernelHandle, cognitive: Cognitive });

const Result: KernelRuntimeTurn | undefined = await Runtime.runTask(
    Work.tid,
    "My TypeScript build fails after a dependency upgrade. What should I check first?",
);
if (Result === (void 0)) {
    console.error("no task was run");
    process.exitCode = 1;
} else {
    console.log(Result.turn.answer);
    console.log(
        `\nstatus=${Result.report.status} tokens=${Result.report.usage.tokens ?? 0} input=${Result.turn.usage?.inputTokens ?? 0} output=${Result.turn.usage?.outputTokens ?? 0}`,
    );
    console.log(
        `scenario=${Result.turn.scenario.active.join(",")} interaction=${Result.turn.interaction.primary} attention=${Result.turn.attention.utilization.toFixed(2)}`,
    );
    console.log(`object=${Result.objectId} receipt=${Result.receiptId}`);
}
KernelHandle.close();
Db.close();
