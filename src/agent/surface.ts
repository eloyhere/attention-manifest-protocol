import { Optional, SynchronousUnorderedMap, SynchronousUnorderedSet, isString } from "semantic-typescript";

/**
 * Declarative agent surface: which domain modules become model tools, which stay
 * host-only, and which are hidden from the model entirely.
 *
 * The registry is data, not authority. A host must still bind identity, check
 * policy/budget and journal every call; the tier table only prevents a module
 * from being offered to the model at all.
 */
export type SurfaceTier = "agent" | "host" | "hidden";

export interface SurfaceVerb {
    readonly verb: string;
    /** True when the verb can change durable state. */
    readonly mutating: boolean;
    /** Authority the host must check before dispatching. */
    readonly authority: readonly string[];
    readonly summary: string;
}

export interface WithheldVerb {
    readonly verb: string;
    readonly reason: string;
}

export interface SurfaceModule {
    readonly module: string;
    readonly tier: SurfaceTier;
    readonly summary: string;
    readonly exposed: readonly SurfaceVerb[];
    readonly withheld: readonly WithheldVerb[];
}

export interface ToolDescriptor {
    /** `attention_manifest_protocol_<module>.<verb>` */
    readonly name: string;
    readonly module: string;
    readonly verb: string;
    readonly mutating: boolean;
    readonly authority: readonly string[];
    readonly description: string;
    /** Stable action synonyms for discovery; never authorization. */
    readonly keywords?: readonly string[];
}

export interface AgentSurface {
    readonly prefix: string;
    readonly tools: readonly ToolDescriptor[];
    readonly modules: readonly string[];
    readonly hidden: readonly string[];
}

/** Host-bound identity. None of these fields may come from model arguments. */
export interface AgentBinding {
    readonly tenantId: string;
    readonly principalId: string;
    readonly sessionId: string;
    readonly turnId?: string;
    readonly attemptId?: string;
    readonly policyVersion: string;
    readonly cancellationEpoch: number;
}

export const SURFACE_PREFIX = "attention_manifest_protocol";
export const DISCOVER_TOOL_NAME = `${SURFACE_PREFIX}_discover`;

/** Bootstrap entry, independent of any domain module. */
export const DISCOVER_TOOL: ToolDescriptor = Object.freeze({
    name: DISCOVER_TOOL_NAME, module: "discovery", verb: "discover", mutating: false,
    authority: Object.freeze(["execution:find"]),
    description: "Search authorized host modules, AMP tools, session files/content, session outlines, conversation and network; accepts query, sources, limit, maxPerModule, minimumScore and weights, and returns a bounded weighted relevance tree.",
    keywords: Object.freeze(["search", "discover", "find", "搜索", "查找", "发现"]),
});

const RESERVED_PARAMETERS: readonly string[] = Object.freeze([
    "tenantId", "principalId", "sessionId", "turnId", "attemptId", "operationId",
    "policyVersion", "cancellationEpoch", "owner", "lease", "fence", "authority",
]);

const AUTHORITY = {
    sessionRead: ["session:read"],
    sessionReport: ["session:report"],
    turnRead: ["turn:read"],
    turnWrite: ["turn:write"],
    intentRead: ["intent:read"],
    intentClarify: ["intent:clarify"],
    missionRead: ["mission:read"],
    goalRead: ["goal:read"],
    goalEvidence: ["goal:evidence"],
    planRead: ["plan:read"],
    planPropose: ["plan:propose"],
    taskRead: ["task:read"],
    taskProgress: ["task:progress"],
    actionRead: ["action:read"],
    attentionRead: ["attention:read"],
    attentionFocus: ["attention:focus"],
    projectRead: ["project:read"],
    projectWrite: ["project:write"],
    workspaceRead: ["workspace:read"],
    workspaceWrite: ["workspace:write"],
    cooperationRead: ["cooperation:read"],
    cooperationSend: ["cooperation:send"],
    cooperationResult: ["cooperation:result"],
    evidenceRead: ["evidence:read"],
    evidenceCite: ["evidence:cite"],
    executionFind: ["execution:find"],
    executionRun: ["execution:run"],
    executionHandle: ["execution:handle"],
    budgetRead: ["budget:read"],
} as const;

/** Action vocabulary is deliberately broad; it is search metadata, not a permission or a contract. */
const VERB_KEYWORDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
    get: ["fetch", "lookup", "show", "详情", "获取", "查询"],
    list: ["browse", "enumerate", "列表", "浏览", "列出"],
    report_status: ["status", "state", "状态", "汇报"],
    current: ["now", "present", "当前", "现在"],
    respond: ["answer", "reply", "回复", "回答"],
    clarify: ["question", "ask", "澄清", "提问"],
    report: ["progress", "update", "进度", "汇报"],
    submit_clarification: ["clarify", "澄清"],
    submit_evidence: ["evidence", "proof", "证据", "佐证"],
    ready_tasks: ["ready", "available", "待办", "就绪", "可执行"],
    propose_draft: ["draft", "proposal", "propose", "草稿", "提议"],
    list_ready: ["ready", "todo", "待办", "可领取"],
    report_progress: ["progress", "status", "进度", "汇报"],
    context: ["prompt", "compiled", "上下文", "提示"],
    request_focus: ["focus", "attention", "聚焦", "关注"],
    rules: ["policy", "convention", "规则", "规范"],
    metadata: ["meta", "tags", "元数据", "标签"],
    environment: ["env", "dependencies", "配置", "环境", "依赖"],
    describe_environment: ["brief", "gap", "配置", "环境", "简报"],
    outline: ["structure", "symbols", "大纲", "结构"],
    document_outline: ["document", "docx", "pdf", "文档"],
    write: ["edit", "modify", "change", "update", "save", "create", "写入", "修改", "编辑", "保存"],
    inbox: ["messages", "mail", "收件箱", "消息"],
    send: ["message", "reply", "发送", "消息"],
    report_result: ["result", "submit", "结果", "提交"],
    cite: ["citation", "reference", "引用", "引用证据"],
    find_tools: ["search", "discover", "find", "搜索", "查找", "发现"],
    inspect_tool: ["schema", "contract", "inspect", "契约", "查看"],
    run: ["execute", "invoke", "call", "运行", "执行", "调用"],
    read_handle: ["page", "cursor", "handle", "分页", "游标"],
    remaining: ["budget", "left", "quota", "余额", "剩余", "预算"],
});

function verb(verbName: string, mutating: boolean, authority: readonly string[], summary: string): SurfaceVerb {
    return Object.freeze({ verb: verbName, mutating, authority: Object.freeze([...authority]), summary });
}

function withheld(verbName: string, reason: string): WithheldVerb {
    return Object.freeze({ verb: verbName, reason });
}

/** Tier table. `exposed` is only allowed for `agent` modules. */
export const SURFACE_MODULES: readonly SurfaceModule[] = Object.freeze([
    Object.freeze({
        module: "session", tier: "agent", summary: "Current session context and status reporting.",
        exposed: Object.freeze([
            verb("get", false, AUTHORITY.sessionRead, "Read the bound session."),
            verb("list", false, AUTHORITY.sessionRead, "List sessions visible to the binding."),
            verb("report_status", false, AUTHORITY.sessionReport, "Report a session-level status line."),
        ]),
        withheld: Object.freeze([
            withheld("create", "session creation belongs to the host"),
            withheld("close", "closing a session is a host lifecycle decision"),
            withheld("archive", "archival is a host retention decision"),
        ]),
    }),
    Object.freeze({
        module: "turn", tier: "agent", summary: "Current turn, model response and clarification.",
        exposed: Object.freeze([
            verb("current", false, AUTHORITY.turnRead, "Read the current turn."),
            verb("respond", true, AUTHORITY.turnWrite, "Submit the model response for the current turn."),
            verb("clarify", true, AUTHORITY.turnWrite, "Ask the user a clarifying question."),
            verb("report", true, AUTHORITY.turnWrite, "Report progress inside the turn."),
        ]),
        withheld: Object.freeze([
            withheld("create", "turn boundaries are host controlled"),
            withheld("interpret", "intent interpretation is host owned"),
            withheld("interrupt", "interruption is a host/user action"),
        ]),
    }),
    Object.freeze({
        module: "intent", tier: "agent", summary: "Captured intent; the model may clarify but not accept.",
        exposed: Object.freeze([
            verb("get", false, AUTHORITY.intentRead, "Read an intent."),
            verb("list", false, AUTHORITY.intentRead, "List intents in scope."),
            verb("submit_clarification", true, AUTHORITY.intentClarify, "Attach a clarification proposal for host review."),
        ]),
        withheld: Object.freeze([
            withheld("capture", "intent capture belongs to the host"),
            withheld("accept", "acceptance is a user/host confirmation"),
        ]),
    }),
    Object.freeze({
        module: "mission", tier: "agent", summary: "Strategic mission summary, read only.",
        exposed: Object.freeze([verb("get", false, AUTHORITY.missionRead, "Read the mission summary.")]),
        withheld: Object.freeze([withheld("*", "mission lifecycle is host owned")]),
    }),
    Object.freeze({
        module: "goal", tier: "agent", summary: "Goals and acceptance criteria; acceptance stays independent.",
        exposed: Object.freeze([
            verb("get", false, AUTHORITY.goalRead, "Read a goal and its criteria."),
            verb("list", false, AUTHORITY.goalRead, "List goals in scope."),
            verb("submit_evidence", true, AUTHORITY.goalEvidence, "Submit evidence references for host verification."),
        ]),
        withheld: Object.freeze([
            withheld("achieve", "achievement requires independent verification"),
            withheld("invalidate", "invalidation is a host/verifier decision"),
            withheld("revalidate", "revalidation is a host/verifier decision"),
        ]),
    }),
    Object.freeze({
        module: "plan", tier: "agent", summary: "Plans and ready tasks; the model may propose drafts.",
        exposed: Object.freeze([
            verb("get", false, AUTHORITY.planRead, "Read a plan."),
            verb("list", false, AUTHORITY.planRead, "List plans in scope."),
            verb("ready_tasks", false, AUTHORITY.planRead, "List tasks whose dependencies are satisfied."),
            verb("propose_draft", true, AUTHORITY.planPropose, "Propose a draft plan for host approval."),
        ]),
        withheld: Object.freeze([
            withheld("activate", "activation is a host approval"),
            withheld("complete", "completion depends on verified tasks"),
            withheld("supersede", "supersede is a host planning decision"),
        ]),
    }),
    Object.freeze({
        module: "task", tier: "agent", summary: "Tasks the binding may work on.",
        exposed: Object.freeze([
            verb("get", false, AUTHORITY.taskRead, "Read a task."),
            verb("list_ready", false, AUTHORITY.taskRead, "List tasks ready for an attempt."),
            verb("report_progress", true, AUTHORITY.taskProgress, "Report progress for the current attempt."),
        ]),
        withheld: Object.freeze([
            withheld("claim", "claiming a task requires a host lease"),
            withheld("accept", "task acceptance is a host/verifier decision"),
            withheld("fail", "terminal failure is a host decision"),
        ]),
    }),
    Object.freeze({
        module: "action", tier: "agent", summary: "Action attempts, read only for the model.",
        exposed: Object.freeze([
            verb("get", false, AUTHORITY.actionRead, "Read an action attempt."),
            verb("list", false, AUTHORITY.actionRead, "List attempts for a task."),
        ]),
        withheld: Object.freeze([
            withheld("start", "starting an attempt needs policy, budget and a lease"),
            withheld("settle", "settlement must come from the execution chain"),
            withheld("reconcile", "reconciliation is a host responsibility"),
        ]),
    }),
    Object.freeze({
        module: "attention", tier: "agent", summary: "Compiled context and focus requests; residency is host policy.",
        exposed: Object.freeze([
            verb("context", false, AUTHORITY.attentionRead, "Read the compiled context for this turn."),
            verb("get", false, AUTHORITY.attentionRead, "Read one attention object."),
            verb("request_focus", true, AUTHORITY.attentionFocus, "Request focus for an object; the host decides."),
        ]),
        withheld: Object.freeze([
            withheld("mount", "residency is attention policy"),
            withheld("unmount", "residency is attention policy"),
            withheld("persist", "retention spends budget and needs approval"),
            withheld("associate", "traversal can amplify reads and leak scope"),
        ]),
    }),
    Object.freeze({
        module: "project", tier: "agent", summary: "Project knowledge and environment; configuration is guided, not applied.",
        exposed: Object.freeze([
            verb("rules", false, AUTHORITY.projectRead, "Read project rules."),
            verb("metadata", false, AUTHORITY.projectRead, "Read project metadata."),
            verb("environment", false, AUTHORITY.projectRead, "Read the project environment (names, paths, dependencies)."),
            verb("describe_environment", false, AUTHORITY.projectRead, "Read the configuration brief and remaining gaps."),
            verb("configure_environment", true, AUTHORITY.projectWrite, "Apply a project environment patch (variables, paths, dependencies) with CAS."),
            verb("put_rule", true, AUTHORITY.projectWrite, "Create or update a project rule with an expected version."),
        ]),
        withheld: Object.freeze([
            withheld("putMetadata", "project metadata is written by the host or a plugin"),
            withheld("putView", "views are produced by the host pipeline"),
            withheld("views", "§13.5 视图渲染与脑图结构不进模型上下文"),
            withheld("outline", "§13.5 视图渲染与脑图结构不进模型上下文"),
        ]),
    }),
    Object.freeze({
        module: "workspace", tier: "agent", summary: "Scoped files: read, outline, and CAS-guarded text writes.",
        exposed: Object.freeze([
            verb("list", false, AUTHORITY.workspaceRead, "List workspace entries."),
            verb("read", false, AUTHORITY.workspaceRead, "Read a text range or line window."),
            verb("outline", false, AUTHORITY.workspaceRead, "Read a file outline."),
            verb("document_outline", false, AUTHORITY.workspaceRead, "Read a binary document outline."),
            verb("diff", false, AUTHORITY.workspaceRead, "Compare the buffer with the committed base and return structured hunks."),
            verb("write", true, AUTHORITY.workspaceWrite, "Write text with expected hash and line/byte/outline targeting."),
        ]),
        withheld: Object.freeze([
            withheld("storage", "raw storage adapters, leases and locks stay host side"),
            withheld("writeBytes", "format-aware binary writes belong to plugins"),
        ]),
    }),
    Object.freeze({
        module: "cooperation", tier: "agent", summary: "Messages and result submission inside an existing delegation.",
        exposed: Object.freeze([
            verb("inbox", false, AUTHORITY.cooperationRead, "Read messages addressed to this agent."),
            verb("send", true, AUTHORITY.cooperationSend, "Send a message within the delegated scope."),
            verb("report_result", true, AUTHORITY.cooperationResult, "Submit a delegated result with provenance."),
        ]),
        withheld: Object.freeze([
            withheld("delegate", "delegation creates authority and needs host approval"),
            withheld("transfer", "ownership transfer changes fencing"),
            withheld("cancel", "cancellation is a host/user decision"),
        ]),
    }),
    Object.freeze({
        module: "evidence", tier: "agent", summary: "Evidence citations; creation and revocation stay host side.",
        exposed: Object.freeze([
            verb("get", false, AUTHORITY.evidenceRead, "Read evidence."),
            verb("list", false, AUTHORITY.evidenceRead, "List evidence in scope."),
            verb("cite", false, AUTHORITY.evidenceCite, "Cite evidence ids in a response."),
        ]),
        withheld: Object.freeze([
            withheld("add", "evidence is created by the verification chain"),
            withheld("revoke", "revocation is a host/verifier decision"),
        ]),
    }),
    Object.freeze({
        module: "execution", tier: "agent", summary: "The only way the model can act: find, inspect, run, read handles.",
        exposed: Object.freeze([
            verb("find_tools", false, AUTHORITY.executionFind, "Rank authorized tools for a query."),
            verb("inspect_tool", false, AUTHORITY.executionFind, "Expand a pinned tool contract."),
            verb("run", true, AUTHORITY.executionRun, "Run typed child calls through policy, budget and journal."),
            verb("read_handle", false, AUTHORITY.executionHandle, "Read one page of a scoped result handle."),
        ]),
        withheld: Object.freeze([
            withheld("executor", "executor internals are not a tool"),
            withheld("journal", "the host owns the durable journal"),
        ]),
    }),
    Object.freeze({
        module: "budget", tier: "agent", summary: "Remaining budget only; granting is a host power.",
        exposed: Object.freeze([verb("remaining", false, AUTHORITY.budgetRead, "Read remaining budget for the binding.")]),
        withheld: Object.freeze([
            withheld("grant", "budget is power and cannot be self-granted"),
            withheld("configure", "budget configuration is a host decision"),
        ]),
    }),
    Object.freeze({
        module: "workflow", tier: "hidden",
        summary: "Single-writer lifecycle kernel; exposing transitions would bypass CAS, epochs and DAG guards.",
        exposed: Object.freeze([]), withheld: Object.freeze([withheld("*", "single-writer state machine, host only")]),
    }),
    Object.freeze({
        module: "policy", tier: "hidden",
        summary: "Policy decision and enforcement; visible policy can be gamed.",
        exposed: Object.freeze([]), withheld: Object.freeze([withheld("*", "authorization must stay outside the model")]),
    }),
    Object.freeze({
        module: "profession", tier: "hidden",
        summary: "Profession narrows authority; a model that can pick it can widen itself.",
        exposed: Object.freeze([]), withheld: Object.freeze([withheld("*", "authority narrowing is host configured")]),
    }),
    Object.freeze({
        module: "behaviour", tier: "hidden",
        summary: "Behavior release governance needs independent evaluation and human approval.",
        exposed: Object.freeze([]), withheld: Object.freeze([withheld("*", "publishing or revoking behavior is a governance action")]),
    }),
    Object.freeze({
        module: "capability", tier: "host", summary: "Capability registry: trust root for what may run.",
        exposed: Object.freeze([]), withheld: Object.freeze([withheld("*", "registration and activation are host owned")]),
    }),
    Object.freeze({
        module: "manifest", tier: "host", summary: "Pinned tool manifests and endpoint identity.",
        exposed: Object.freeze([]), withheld: Object.freeze([withheld("*", "tool contracts and endpoint identity are host trusted")]),
    }),
    Object.freeze({
        module: "provenance", tier: "host", summary: "Receipt creation for executed effects.",
        exposed: Object.freeze([]), withheld: Object.freeze([withheld("*", "receipts must come from the execution chain")]),
    }),
    Object.freeze({
        module: "receipt", tier: "host", summary: "Immutable execution facts.",
        exposed: Object.freeze([]), withheld: Object.freeze([withheld("*", "receipts are host written; the model may only cite evidence")]),
    }),
    Object.freeze({
        module: "verification", tier: "host", summary: "Independent verification of observations.",
        exposed: Object.freeze([]), withheld: Object.freeze([withheld("*", "verification authority is host owned")]),
    }),
    Object.freeze({
        module: "retrieval", tier: "host", summary: "Candidate ranking internals behind execution.find_tools.",
        exposed: Object.freeze([]), withheld: Object.freeze([withheld("*", "reached only through execution.find_tools")]),
    }),
    Object.freeze({
        module: "model", tier: "host", summary: "Model proposal port.",
        exposed: Object.freeze([]), withheld: Object.freeze([withheld("*", "the model cannot call itself as a tool")]),
    }),
    Object.freeze({
        module: "runtime", tier: "host", summary: "Execution coordinator and LCP facade.",
        exposed: Object.freeze([]), withheld: Object.freeze([withheld("*", "the facade is exposed through execution.*")]),
    }),
]);

const MODULE_INDEX = new SynchronousUnorderedMap<string, SurfaceModule>();
for (const entry of SURFACE_MODULES) {
    if (MODULE_INDEX.containsKey(entry.module)) throw new TypeError(`duplicate surface module: ${entry.module}`);
    MODULE_INDEX.put(entry.module, entry);
}

function buildTools(): readonly ToolDescriptor[] {
    const names = new SynchronousUnorderedSet<string>();
    const tools: ToolDescriptor[] = [];
    for (const entry of SURFACE_MODULES) {
        if (entry.tier !== "agent") {
            if (entry.exposed.length > 0) throw new TypeError(`module ${entry.module} is ${entry.tier} but exposes verbs`);
            continue;
        }
        if (entry.exposed.length === 0) throw new TypeError(`agent module ${entry.module} exposes no verbs`);
        for (const item of entry.exposed) {
            const name = `${SURFACE_PREFIX}_${entry.module}.${item.verb}`;
            if (names.contains(name)) throw new TypeError(`duplicate tool name: ${name}`);
            if (item.authority.length === 0) throw new TypeError(`tool ${name} must declare authority`);
            names.add(name);
            tools.push(Object.freeze({ name, module: entry.module, verb: item.verb, mutating: item.mutating,
                authority: item.authority, description: item.summary,
                keywords: Object.freeze([...(VERB_KEYWORDS[item.verb] ?? [])]) }));
        }
    }
    return Object.freeze(tools);
}

const ALL_TOOLS = buildTools();

export function findModule(module: string): Optional<SurfaceModule> {
    return isString(module) ? MODULE_INDEX.get(module) : Optional.empty<SurfaceModule>();
}

export function findTool(name: string): Optional<ToolDescriptor> {
    if (name === DISCOVER_TOOL_NAME) { return Optional.of(DISCOVER_TOOL); }
    return Optional.ofNullable(ALL_TOOLS.find(tool => tool.name === name));
}

/** Offer this single entry initially; load selected domain contracts after discovery. */
export function createDiscoverySurface(): AgentSurface {
    return Object.freeze({ prefix: SURFACE_PREFIX, tools: Object.freeze([DISCOVER_TOOL]),
        modules: Object.freeze([] as string[]), hidden: Object.freeze([] as string[]) });
}

/** Throws unless the module may be offered to the model. */
export function assertAgentAccessible(module: string): SurfaceModule {
    const found = findModule(module);
    if (found.isEmpty()) throw new TypeError(`unknown surface module: ${module}`);
    const entry = found.get();
    if (entry.tier !== "agent") throw new TypeError(`module ${module} is ${entry.tier}, not agent accessible`);
    return entry;
}

export function isHidden(module: string): boolean {
    const found = findModule(module);
    return found.isPresent() && found.get().tier === "hidden";
}

export interface AgentSurfaceOptions {
    /** Restrict the surface to these agent modules; host/hidden names are rejected. */
    readonly only?: readonly string[];
}

export function createAgentSurface(options: AgentSurfaceOptions = {}): AgentSurface {
    const allowed = options.only === undefined ? undefined : new SynchronousUnorderedSet<string>();
    if (allowed) for (const module of options.only ?? []) {
        assertAgentAccessible(module);
        allowed.add(module);
    }
    const tools = options.only === undefined
        ? ALL_TOOLS
        : ALL_TOOLS.filter(tool => allowed!.contains(tool.module));
    const modules = SURFACE_MODULES.filter(entry => entry.tier === "agent").map(entry => entry.module);
    const hidden = SURFACE_MODULES.filter(entry => entry.tier === "hidden").map(entry => entry.module);
    return Object.freeze({ prefix: SURFACE_PREFIX, tools, modules: Object.freeze(modules), hidden: Object.freeze(hidden) });
}

/** Validates host-bound identity; an absent or malformed binding must never dispatch. */
export function assertBinding(binding: AgentBinding): void {
    for (const field of ["tenantId", "principalId", "sessionId", "policyVersion"] as const) {
        if (!isString(binding[field]) || binding[field].trim() === "") throw new TypeError(`binding.${field} is required`);
    }
    if (!Number.isSafeInteger(binding.cancellationEpoch) || binding.cancellationEpoch < 0) {
        throw new TypeError("binding.cancellationEpoch must be a nonnegative safe integer");
    }
}

/** Rejects model arguments that try to supply host-bound context, at any depth. */
export function assertModelParameters(parameters: Readonly<Record<string, unknown>>): void {
    if (typeof parameters !== "object" || parameters === null || Array.isArray(parameters)) throw new TypeError("tool parameters must be an object");
    const visit = (value: unknown): void => {
        if (Array.isArray(value)) {
            for (const item of value) visit(item);
            return;
        }
        if (typeof value !== "object" || value === null) return;
        for (const [key, child] of Object.entries(value)) {
            if (RESERVED_PARAMETERS.includes(key)) throw new TypeError(`parameter ${key} is bound by the host and cannot be supplied by the model`);
            visit(child);
        }
    };
    visit(parameters);
}

/** Renders the surface for prompts, tool listings or review. */
export function describeSurface(surface: AgentSurface = createAgentSurface()): string {
    const lines: string[] = ["# Agent surface", "", "## Tools"];
    for (const tool of surface.tools) {
        lines.push(`- ${tool.name}${tool.mutating ? " (mutating)" : ""} — ${tool.description} [${tool.authority.join(", ")}]`);
    }
    lines.push("", "## Withheld from the model");
    for (const entry of SURFACE_MODULES) {
        if (entry.tier === "agent") continue;
        lines.push(`- ${entry.module} (${entry.tier}) — ${entry.summary}`);
    }
    return lines.join("\n");
}
