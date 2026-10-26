#!/usr/bin/env node
/**
 * Registry checks: every source directory is a module with a content digest,
 * concepts are rows, dependencies are acyclic, and attestations point into the
 * evidence chain. A directory change after declaration is reported as drift.
 */
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Database } from "../src/database/service/database.ts";
import {
    attest,
    declareConcept,
    declareModule,
    dependencies,
    digestDirectory,
    hasDependencyCycle,
    linkConcept,
    linkDependency,
    verifyModuleContent,
    verifyRegistry,
} from "../src/registry/index.ts";
import type { ConceptLinkRole, ModuleKind } from "../src/registry/index.ts";

const At: string = "2026-10-24T00:00:00.000Z";

let passed: number = 0;
let failed: number = 0;
const tasks: Array<() => Promise<void>> = [];

const test = (name: string, fn: () => void | Promise<void>): void => {
    tasks.push(async (): Promise<void> => {
        try {
            await fn();
            passed += 1;
            console.log(`\x1b[32m✓\x1b[0m ${name}`);
        } catch (error) {
            failed += 1;
            const message: string = error instanceof Error ? error.message : `${error}`;
            console.error(`\x1b[31m✗\x1b[0m ${name}\n      ${message}`);
        }
    });
};

const kindFor = (name: string): ModuleKind => {
    if (name === "kernel") return "kernel";
    if (name === "database" || name === "store") return "database";
    if (name === "module") return "module";
    if (name === "protocol") return "protocol";
    if (name === "structure") return "structure";
    if (name === "registry") return "tool";
    if (name === "boundary") return "boundary";
    return "domain";
};

const concepts = [
    ["process", "进程", "persistent agent: owns budget, memory, capabilities and a parent"],
    ["thread", "线程", "task or goal scheduled by an agent; one running task per agent"],
    ["capability", "能力", "不可伪造、可衰减、可撤销的句柄"],
    ["permission", "权限", "主体对资源可以执行的动作集合"],
    ["window", "窗口", "以 token 为容量的上下文地址空间"],
    ["page", "页", "窗口中的一个可寻址段，指向不可变对象"],
    ["mailbox", "邮箱", "跨进程有界消息队列"],
    ["mission", "任务队列", "进程的优先级准入队列"],
    ["goal", "目标", "带成功判据与生命周期的意图"],
    ["warrant", "凭据", "主张、证据、假设与未知的依赖结构"],
    ["claim", "主张", "带等级、反证条件与置信度的陈述"],
    ["evidence", "证据", "支持或反驳主张的可追溯材料"],
    ["frame", "注意帧", "一次不可变的注意力分配"],
    ["receipt", "回执", "一次行动的结算记录"],
    ["budget", "预算", "token/调用/时间/金额约束"],
    ["lease", "租约", "跨 worker 的互斥与 fencing"],
    ["worker", "工作者", "一个内核实例，有心跳与过期回收"],
    ["address-space", "地址空间", "进程可见的不可变对象集合"],
    ["registry", "注册表", "概念与模块的持久目录"],
    ["module", "模块", "有入口、版本与凭证的代码单元"],
    ["context", "上下文", "窗口页到提示的装配结果"],
    ["store", "缓存层", "Proxy 读穿 + LRU 的服务缓存"],
    ["boundary", "边界", "构造即拒绝的校验层"],
    ["kernel", "内核", "进程/线程/预算/窗口的调度器"],
    ["database", "数据库", "实体、仓库、服务、SQL 与存储"],
] as const;

const links: Array<[string, string, ConceptLinkRole]> = [
    ["process", "process", "owns"],
    ["thread", "thread", "owns"],
    ["authz", "permission", "owns"],
    ["authz", "capability", "owns"],
    ["window", "window", "owns"],
    ["window", "page", "owns"],
    ["ipc", "mailbox", "owns"],
    ["mission", "mission", "owns"],
    ["goal", "goal", "owns"],
    ["warrant", "warrant", "owns"],
    ["warrant", "claim", "owns"],
    ["warrant", "evidence", "owns"],
    ["frame", "frame", "owns"],
    ["receipt", "receipt", "owns"],
    ["lock", "lease", "owns"],
    ["concurrency", "worker", "owns"],
    ["process", "address-space", "owns"],
    ["registry", "registry", "owns"],
    ["registry", "module", "owns"],
    ["context", "context", "owns"],
    ["store", "store", "owns"],
    ["boundary", "boundary", "owns"],
    ["kernel", "kernel", "owns"],
    ["database", "database", "owns"],
];

const dirs: string[] = readdirSync("src", { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
const digests = new Map<string, string>();
for (const dir of dirs) digests.set(dir, await digestDirectory(`src/${dir}`));

const declareAll = (db: Database): void => {
    for (const dir of dirs) {
        declareModule(db.db, { id: dir, kind: kindFor(dir), entry: `src/${dir}`, description: `module ${dir}`, contentDigest: digests.get(dir) ?? "" }, At);
    }
    for (const [id, label, definition] of concepts) declareConcept(db.db, { id, label, definition }, At);
    for (const [moduleId, conceptId, role] of links) linkConcept(db.db, moduleId, conceptId, role);
};

test("every source directory is a module with a content digest", async () => {
    const db = new Database(":memory:");
    declareAll(db);
    const rows = db.moduleService.list();
    assert.equal(rows.length, dirs.length);
    for (const dir of dirs) assert.ok(db.moduleService.byPublicId(dir), `missing module ${dir}`);
    for (const row of rows) {
        assert.notEqual(row.object_seq, null, `module ${row.id} has no declaration object`);
        assert.notEqual(row.content_digest, null, `module ${row.id} has no content digest`);
    }
    const verdict = await verifyModuleContent(db.db, digestDirectory);
    assert.equal(verdict.ok, true, verdict.reasons.join("; "));
    db.close();
});

test("concepts are rows and redeclaration creates a new version", () => {
    const db = new Database(":memory:");
    declareAll(db);
    const first = db.conceptService.byPublicId("process");
    assert.ok(first);
    const second = declareConcept(db.db, { id: "process", label: "Process", definition: "mission as a resource container" }, At);
    assert.equal(second.row.version, 2);
    assert.equal(second.objectId, "concept.process.v2");
    assert.notEqual(second.hash, first.digest === null ? "" : first.digest);
    db.close();
});

test("dependency links reject cycles and are queryable", () => {
    const db = new Database(":memory:");
    declareAll(db);
    assert.equal(linkDependency(db.db, "kernel", "database", "owns the store"), true);
    assert.equal(linkDependency(db.db, "database", "store", "uses the store"), true);
    assert.throws(() => linkDependency(db.db, "store", "kernel", "invalid cycle"), /cycle/);
    assert.equal(hasDependencyCycle(db.db), false);
    assert.equal(dependencies(db.db, "kernel").length, 1);
    assert.equal(dependencies(db.db, "kernel")[0]?.dependsOn, "database");
    db.close();
});

test("attestations point into the evidence chain and verify", () => {
    const db = new Database(":memory:");
    declareAll(db);
    db.objectService.put("claim", "cl.registry.1", { statement: "the kernel owns process scheduling" }, At);
    const attestation = attest(db.db, "module", "kernel", "cl.registry.1", At);
    assert.ok(attestation.aid > 0);
    assert.equal(db.attestationService.forSubject("module", "kernel").length, 1);
    const verdict = verifyRegistry(db.db);
    assert.equal(verdict.ok, true, verdict.reasons.join("; "));
    db.close();
});

test("content drift after declaration is detected", async () => {
    const dir: string = await mkdtemp(join(tmpdir(), "amp-registry-"));
    try {
        await writeFile(join(dir, "a.ts"), "export const value = 1;\n", "utf8");
        const digest: string = await digestDirectory(dir);
        const db = new Database(":memory:");
        declareModule(db.db, { id: "temp.module", kind: "domain", entry: dir, description: "temporary module", contentDigest: digest }, At);
        const before = await verifyModuleContent(db.db, digestDirectory);
        assert.equal(before.ok, true, before.reasons.join("; "));
        await writeFile(join(dir, "a.ts"), "export const value = 2;\n", "utf8");
        const after = await verifyModuleContent(db.db, digestDirectory);
        assert.equal(after.ok, false);
        db.close();
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("tampering with a declaration object is detected", () => {
    const db = new Database(":memory:");
    declareAll(db);
    db.db.exec("UPDATE objects SET body = '{}' WHERE kind = 'concept'");
    assert.equal(verifyRegistry(db.db).ok, false);
    db.close();
});

for (const task of tasks) await task();
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
