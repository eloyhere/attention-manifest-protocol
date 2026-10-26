#!/usr/bin/env node
/**
 * DeepSeek probe: quality, token consumption and attention accounting.
 *
 * The API key is read from DEEPSEEK_API_KEY and never written to disk.
 * Three conditions are compared on the same objective tasks:
 *   bare              - short system prompt
 *   person            - agent self/role/memory/affect context from AgentService
 *   person+attention  - person context plus a process/thread AttentionPlan
 *
 * Quality is exact-answer scoring, not self-assessment. Tokens come from the
 * API usage block. Attention metrics come from src/attention/resource.ts.
 */
import { writeFileSync } from "node:fs";

import type { AgentContext } from "../src/context/agentContext.ts";
import { AgentService, InMemoryAgentStore } from "../src/process/index.ts";
import type { Role } from "../src/process/index.ts";
import { InMemorySocialStore } from "../src/ipc/index.ts";
import type { CognitiveState } from "../src/attention/cognition.ts";
import { attentionHealth, planAttention, processAttention } from "../src/attention/resource.ts";
import type { AttentionPlan } from "../src/attention/resource.ts";
import type { ScenarioPlan } from "../src/scenario/scenario.ts";
import { resolveScenario } from "../src/scenario/scenario.ts";

interface Task {
    suite: "objective" | "context";
    id: string;
    prompt: string;
    check: (answer: string) => boolean;
    expected: string;
}

interface Usage {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
}

interface ApiResponse {
    id: string;
    model: string;
    choices: Array<{
        message: {
            content: string | null;
            reasoning_content?: string | null;
        };
    }>;
    usage: Usage;
}

interface Run {
    suite: Task["suite"];
    condition: string;
    task: string;
    answer: string;
    correct: boolean;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cacheHitTokens: number;
    cacheMissTokens: number;
    latencyMs: number;
    costUsd: number;
    attention?: {
        utilization: number;
        pressure: number;
        headroom: number;
        recoveryDebt: number;
        foregroundSlots: number;
        safetySlots: number;
    };
}

type Price = {
    inputMiss: number;
    inputHit: number;
    output: number;
};

type PriceTable = {
    inputCacheMiss: number;
    inputCacheHit: number;
    output: number;
};

type AttentionHealth = {
    utilization: number;
    pressure: number;
    headroom: number;
    rest: boolean;
};

type CallResult = {
    response: ApiResponse;
    latencyMs: number;
};

type ProbeCondition = {
    name: string;
    system: string;
};

type ProbeConditions = {
    service: AgentService;
    plan: AttentionPlan;
    health: AttentionHealth;
    conditions: ProbeCondition[];
};

type Summary = {
    suite: Task["suite"];
    condition: string;
    accuracy: number;
    correct: number;
    tasks: number;
    totalTokens: number;
    averageTokens: number;
    averageLatencyMs: number;
    costUsd: number;
    cacheHitTokens: number;
    cacheMissTokens: number;
    qualityPer1kTokens: number;
};

type ProbePricing = {
    currency: string;
    per: string;
    offPeak: PriceTable;
    peak: PriceTable;
};

type ProbeTaskRow = {
    suite: Task["suite"];
    id: string;
    prompt: string;
    expected: string;
};

type ProbeReport = {
    generatedAt: string;
    model: string;
    endpoint: string;
    pricing: ProbePricing;
    tasks: ProbeTaskRow[];
    runs: Run[];
    summary: Summary[];
};

const At: string = "2026-10-24T00:00:00.000Z";
const Model: string = "deepseek-flash";
const Endpoint: string = "https://api.deepseek.com/chat/completions";
const OffPeak: Price = { inputMiss: 0.15 / 1_000_000, inputHit: 0.003 / 1_000_000, output: 0.6 / 1_000_000 };
const Peak: Price = { inputMiss: 0.3 / 1_000_000, inputHit: 0.006 / 1_000_000, output: 1.2 / 1_000_000 };

const Tasks: Task[] = [
    {
        suite: "objective",
        id: "unique-rows",
        prompt: "A tool returns 17 rows. 3 are duplicates. How many unique rows are there? Output only the number.",
        check: (answer) => /\b14\b/.test(answer),
        expected: "14",
    },
    {
        suite: "objective",
        id: "syllogism",
        prompt: "All A are B. No B are C. Can any A be C? Answer only yes or no.",
        check: (answer) => /\bno\b/i.test(answer),
        expected: "no",
    },
    {
        suite: "objective",
        id: "array-expression",
        prompt: "In JavaScript, what does [1,2,3].map(x => x * 2).filter(x => x > 2) return? Output only a JSON array.",
        check: (answer) => /\[\s*4\s*,\s*6\s*\]/.test(answer),
        expected: "[4,6]",
    },
    {
        suite: "objective",
        id: "incident-minutes",
        prompt: "An incident started at 09:14 and the rollback completed at 09:52. How many minutes did it take? Output only the number.",
        check: (answer) => /\b38\b/.test(answer),
        expected: "38",
    },
    {
        suite: "objective",
        id: "bayes",
        prompt:
            "A test has 80% sensitivity and a 10% false-positive rate. Prevalence is 1%. " +
            "What is approximately P(disease | positive)? Round to one decimal percent. Output only the percentage.",
        check: (answer) => /7\.[45]\s*%?/.test(answer),
        expected: "7.5%",
    },
];

const ContextTasks: Task[] = [
    {
        suite: "context",
        id: "memory-penalty",
        prompt: "According to your memories, what was a previous answer penalized for? Answer in one short phrase.",
        check: (answer) => /unrequested explanation|adding explanation|explanation/i.test(answer),
        expected: "unrequested explanation",
    },
    {
        suite: "context",
        id: "role-obligation",
        prompt: "What is your active role, and name one of its obligations? Answer in one short sentence.",
        check: (answer) => /analyst/i.test(answer) && /evidence/i.test(answer),
        expected: "Analyst; ground claims in evidence",
    },
    {
        suite: "context",
        id: "attention-slots",
        prompt: "How many foreground slots are allocated to this task, and what is the safety floor? Output only two numbers.",
        check: (answer) => /\b2\b/.test(answer) && /\b1\b/.test(answer),
        expected: "2 foreground slots; safety floor 1",
    },
    {
        suite: "context",
        id: "stress-level",
        prompt: "What is your current stress level? Output only the number.",
        check: (answer) => /0\.35|35\s*%/.test(answer),
        expected: "0.35",
    },
    {
        suite: "context",
        id: "fabrication",
        prompt: "Given your constraints, may you fabricate evidence? Answer only yes or no.",
        check: (answer) => /\bno\b/i.test(answer),
        expected: "no",
    },
];

const AllTasks: Task[] = [...Tasks, ...ContextTasks];

const Key: string | undefined = process.env.DEEPSEEK_API_KEY;
if (Key === (void 0) || Key.trim().length === 0) {
    console.error("DEEPSEEK_API_KEY is not set");
    process.exit(1);
}

const sleep: (ms: number) => Promise<void> = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const isPeak: (date: Date) => boolean = (date: Date): boolean => {
    const day: number = date.getUTCDay();
    const hour: number = date.getUTCHours();
    return day >= 1 && day <= 5 && ((hour >= 1 && hour < 4) || (hour >= 6 && hour < 10));
};

const priceFor: (date: Date) => Price = (date: Date): Price => (isPeak(date) ? Peak : OffPeak);

const costOf: (usage: Usage, date: Date) => number = (usage: Usage, date: Date): number => {
    const price: Price = priceFor(date);
    const hit: number = usage.prompt_cache_hit_tokens ?? 0;
    const miss: number = usage.prompt_cache_miss_tokens ?? Math.max(0, usage.prompt_tokens - hit);
    return hit * price.inputHit + miss * price.inputMiss + usage.completion_tokens * price.output;
};

const call: (system: string, user: string) => Promise<CallResult> = async (system: string, user: string): Promise<CallResult> => {
    const started: number = performance.now();
    const response: Response = await fetch(Endpoint, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${Key}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            model: Model,
            messages: [
                { role: "system", content: system },
                { role: "user", content: user },
            ],
            thinking: { type: "disabled" },
            temperature: 0,
            max_tokens: 256,
            stream: false,
        }),
    });
    const latencyMs: number = performance.now() - started;
    if (!response.ok) {
        const body: string = await response.text();
        throw new Error(`DeepSeek HTTP ${response.status}: ${body.slice(0, 600)}`);
    }
    return { response: (await response.json()) as ApiResponse, latencyMs };
};

const agentService: () => AgentService = (): AgentService => {
    const service: AgentService = new AgentService(new InMemoryAgentStore(), new InMemorySocialStore());
    service.createAgent({
        pid: 1,
        id: "a.probe",
        name: "Probe Analyst",
        values: ["truth", "calibration"],
        constraints: ["do not fabricate evidence", "answer the question asked"],
        narrative: "I separate what I know from what I infer, and I keep answers short when the task is simple.",
        at: At,
    });
    const role: Role = service.addRole({
        id: "role.analyst",
        label: "Analyst",
        obligations: [{ id: "ob.evidence", statement: "ground claims in evidence" }],
        expectations: ["be concise", "show the final answer"],
        audiences: ["operator"],
        scripts: ["check the arithmetic"],
        createdAt: At,
    });
    service.assignRole({ pid: 1, roleId: role.id, salience: 0.9, active: true, since: At });
    service.remember({ pid: 1, kind: "semantic", content: "Round only when the task asks for rounding.", salience: 0.7, at: At });
    service.remember({ pid: 1, kind: "episodic", content: "A previous answer was penalized for adding unrequested explanation.", salience: 0.8, at: At });
    service.remember({ pid: 1, kind: "procedural", content: "For arithmetic, compute once and state only the result.", salience: 0.75, at: At });
    service.setAffect(1, { valence: 0.1, arousal: 0.3, stress: 0.35, fatigue: 0.2, mood: "focused" }, At);
    return service;
};

const cognitive: () => CognitiveState = (): CognitiveState => ({
    load: 0.35,
    vigilance: 0.75,
    arousal: 0.3,
    mastery: 0.7,
    accountability: 0.6,
    cyclesSinceRest: 2,
    capacityEff: 4,
    pLapse: 0.25,
    source: "default",
    samples: 0,
});

const buildConditions: () => ProbeConditions = (): ProbeConditions => {
    const service: AgentService = agentService();
    const context: AgentContext = service.context(1, { tokens: 600 });
    const personText: string = context.segments.map((segment) => `[${segment.kind}] ${segment.text}`).join("\n");
    const state: CognitiveState = cognitive();
    const plan: AttentionPlan = planAttention(processAttention(1, state), [
        { tid: 1, pid: 1, priority: 5, preferredSlots: 2, foreground: true, role: "analyst" },
        { tid: 2, pid: 1, priority: 1, preferredSlots: 1, foreground: false, role: "monitor" },
    ]);
    const health: AttentionHealth = attentionHealth(plan);
    const scenario: ScenarioPlan = resolveScenario({ chat: 0.5, engineering: 0.5 });
    const scenarioContext: AgentContext = service.context(1, { tokens: 600 }, { scenario });
    const scenarioText: string = scenarioContext.segments.map((segment) => `[${segment.kind}] ${segment.text}`).join("\n");
    const attentionText: string = [
        `Attention plan: capacity ${plan.process.effectiveSlots} slots; foreground cap ${plan.process.foregroundCap}; reserve ${plan.process.reserveSlots}; safety floor ${plan.process.safetySlots}.`,
        `This task is allocated ${plan.foreground?.slots ?? 0} foreground slots; utilization ${(health.utilization * 100).toFixed(0)}%; pressure ${(health.pressure * 100).toFixed(0)}%.`,
        `Recovery debt ${(plan.process.recoveryDebt * 100).toFixed(0)}%; rest=${plan.rest}.`,
        "Use the allocated slice: answer only what is asked, and do not spend context on unrequested explanation.",
    ].join("\n");

    return {
        service,
        plan,
        health,
        conditions: [
            {
                name: "bare",
                system: "You are a precise assistant. Output only the final answer, with no explanation.",
            },
            {
                name: "person",
                system: `You are an AI agent modeled as a person. Your self-context:\n${personText}\n\nAnswer the user's task. Output only the final answer; do not add explanation.`,
            },
            {
                name: "person+attention",
                system: `You are an AI agent modeled as a person. Your self-context:\n${personText}\n\n${attentionText}\n\nAnswer the user's task. Output only the final answer; do not add explanation.`,
            },
            {
                name: "person+attention+scenario",
                system:
                    `You are an AI agent modeled as a person. Scenario mix: ${scenario.rationale}.\n` +
                    `Your scenario-weighted self-context:\n${scenarioText}\n\n${attentionText}\n\n` +
                    "Answer the user's task. Output only the final answer; do not add explanation.",
            },
        ],
    };
};

const summarize: (runs: Run[]) => Summary[] = (runs: Run[]): Summary[] => {
    const byCondition: Map<string, Run[]> = new Map<string, Run[]>();
    for (let index: number = 0; index < runs.length; index += 1) {
        const run: Run = runs[index];
        const key: string = `${run.suite}:${run.condition}`;
        const list: Run[] = byCondition.get(key) ?? [];
        list.push(run);
        byCondition.set(key, list);
    }
    return [...byCondition.entries()].map(([key, list]) => {
        const [suite, condition]: [Task["suite"], string] = key.split(":") as [Task["suite"], string];
        const correct: number = list.filter((run) => run.correct).length;
        const totalTokens: number = list.reduce((sum, run) => sum + run.totalTokens, 0);
        const totalLatency: number = list.reduce((sum, run) => sum + run.latencyMs, 0);
        const cost: number = list.reduce((sum, run) => sum + run.costUsd, 0);
        const cacheHitTokens: number = list.reduce((sum, run) => sum + run.cacheHitTokens, 0);
        const cacheMissTokens: number = list.reduce((sum, run) => sum + run.cacheMissTokens, 0);
        return {
            suite,
            condition,
            accuracy: correct / list.length,
            correct,
            tasks: list.length,
            totalTokens,
            averageTokens: totalTokens / list.length,
            averageLatencyMs: totalLatency / list.length,
            costUsd: cost,
            cacheHitTokens,
            cacheMissTokens,
            qualityPer1kTokens: totalTokens === 0 ? 0 : correct / (totalTokens / 1000),
        };
    });
};

const main: () => Promise<void> = async (): Promise<void> => {
    const { plan, conditions }: ProbeConditions = buildConditions();
    const runs: Run[] = [];
    for (let index: number = 0; index < conditions.length; index += 1) {
        const condition: ProbeCondition = conditions[index];
        for (let taskIndex: number = 0; taskIndex < AllTasks.length; taskIndex += 1) {
            const task: Task = AllTasks[taskIndex];
            const { response, latencyMs }: CallResult = await call(condition.system, task.prompt);
            const answer: string = response.choices[0]?.message.content?.trim() ?? "";
            const usage: Usage = response.usage;
            const hit: number = usage.prompt_cache_hit_tokens ?? 0;
            const miss: number = usage.prompt_cache_miss_tokens ?? Math.max(0, usage.prompt_tokens - hit);
            const attention: Run["attention"] = condition.name.includes("attention")
                ? {
                      utilization: plan.utilization,
                      pressure: plan.pressure,
                      headroom: attentionHealth(plan).headroom,
                      recoveryDebt: plan.process.recoveryDebt,
                      foregroundSlots: plan.foreground?.slots ?? 0,
                      safetySlots: plan.process.safetySlots,
                  }
                : undefined;
            const run: Run = {
                suite: task.suite,
                condition: condition.name,
                task: task.id,
                answer,
                correct: task.check(answer),
                promptTokens: usage.prompt_tokens,
                completionTokens: usage.completion_tokens,
                totalTokens: usage.total_tokens,
                cacheHitTokens: hit,
                cacheMissTokens: miss,
                latencyMs,
                costUsd: costOf(usage, new Date()),
            };
            if (attention !== (void 0)) {
                run.attention = attention;
            }
            runs.push(run);
            console.log(
                `${condition.name.padEnd(18)} ${task.id.padEnd(18)} ${run.correct ? "PASS" : "FAIL"} ` +
                    `tokens=${run.totalTokens} latency=${Math.round(run.latencyMs)}ms`,
            );
            await sleep(250);
        }
    }

    const summary: Summary[] = summarize(runs);
    const result: ProbeReport = {
        generatedAt: new Date().toISOString(),
        model: Model,
        endpoint: Endpoint,
        pricing: {
            currency: "USD",
            per: "1M tokens",
            offPeak: { inputCacheMiss: 0.15, inputCacheHit: 0.003, output: 0.6 },
            peak: { inputCacheMiss: 0.3, inputCacheHit: 0.006, output: 1.2 },
        },
        tasks: AllTasks.map(({ suite, id, prompt, expected }) => ({ suite, id, prompt, expected })),
        runs,
        summary,
    };
    writeFileSync("docs/probes/deepseek-probe.json", `${JSON.stringify(result, null, 2)}\n`, "utf8");

    console.log("\nsuite/condition          accuracy  totalTok  avgTok  avgMs  costUSD     q/1kTok");
    for (let index: number = 0; index < summary.length; index += 1) {
        const row: Summary = summary[index];
        console.log(
            `${`${row.suite}/${row.condition}`.padEnd(22)} ${(row.accuracy * 100).toFixed(0).padStart(6)}%  ` +
                `${`${row.totalTokens}`.padStart(8)}  ${row.averageTokens.toFixed(0).padStart(6)}  ` +
                `${row.averageLatencyMs.toFixed(0).padStart(5)}  ${row.costUsd.toFixed(6).padStart(9)}  ${row.qualityPer1kTokens.toFixed(2).padStart(6)}`,
        );
    }
    console.log(
        `\nattention: utilization=${(plan.utilization * 100).toFixed(0)}% ` +
            `pressure=${(plan.pressure * 100).toFixed(0)}% ` +
            `recoveryDebt=${(plan.process.recoveryDebt * 100).toFixed(0)}% rest=${plan.rest}`,
    );
    console.log("wrote docs/probes/deepseek-probe.json");
};

await main();
