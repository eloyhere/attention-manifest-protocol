/**
 * Every registry is read-write.
 *
 * A registry that only implements `register` forces a host to build a second
 * object to change or drop an entry, and the two copies then disagree. This
 * check drives create → read → update → remove → clear on each mutable
 * registry, including the failure modes: an update must reject an unknown id,
 * a duplicate register must still be refused, and removing a language must
 * release its extension so the extension can be re-used.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { EntityRegistry } from "../src/database/entity/entity.ts";
import { CalibrationRegistry } from "../src/bayes/calibrationRegistry.ts";
import { KnowledgeRegistry } from "../src/knowledge/registry.ts";
import { OutlineKeywordRegistry } from "../src/outline/outlineKeywords.ts";
import { OutlineRegistry } from "../src/outline/outline.ts";
import { ProtocolRegistry } from "../src/protocol/registry.ts";
import { SkillRegistry } from "../src/skill/registry.ts";
import { SqlDialectRegistry } from "../src/outline/sqlOutline.ts";
import { SyntaxRegistry } from "../src/syntax/syntaxRegistry.ts";
import { ToolRegistry } from "../src/module/tool/tool.ts";
import { BehaviorRegistry } from "../src/runtime/behavior.ts";

test("skill registry: register, update, remove and clear keep one source of truth", (): void => {
    const skills: SkillRegistry = new SkillRegistry();
    skills.register({ id: "a", name: "A", description: "first", instructions: "do" });
    assert.equal(skills.update({ id: "a", name: "A2", description: "second", instructions: "do" }).name, "A2");
    assert.equal(skills.get("a")?.description, "second");
    assert.throws(() => skills.update({ id: "missing", name: "M", description: "d", instructions: "i" }), /not registered/);
    assert.throws(() => skills.register({ id: "a", name: "Dup", description: "d", instructions: "i" }), /already registered/);
    assert.equal(skills.remove("a"), true);
    assert.equal(skills.remove("a"), false);
    assert.equal(skills.has("a"), false);
    skills.register({ id: "b", name: "B", description: "d", instructions: "i" });
    skills.register({ id: "c", name: "C", description: "d", instructions: "i" });
    assert.equal(skills.clear(), 2);
    assert.deepEqual(skills.list(), []);
});

test("knowledge registry: update replaces content and remove drops the entry", (): void => {
    const knowledge: KnowledgeRegistry = new KnowledgeRegistry();
    knowledge.register({ id: "k", title: "T", summary: "s", content: "v1", tags: ["a"] });
    knowledge.update({ id: "k", title: "T2", summary: "s2", content: "v2", tags: ["b"] });
    assert.deepEqual(knowledge.get("k"), { id: "k", title: "T2", summary: "s2", content: "v2", tags: ["b"] });
    assert.throws(() => knowledge.update({ id: "nope", title: "T", summary: "s", content: "c" }), /not registered/);
    assert.equal(knowledge.remove("k"), true);
    assert.equal(knowledge.get("k"), (void 0));
    assert.equal(knowledge.clear(), 0);
});

test("protocol registry: status can be changed after registration", (): void => {
    const protocols: ProtocolRegistry = new ProtocolRegistry();
    protocols.register({ id: "p", name: "P", version: "1", description: "d", status: "active" });
    protocols.update({ id: "p", name: "P", version: "1", description: "d", status: "disabled" });
    assert.deepEqual(protocols.list(), []);
    assert.equal(protocols.list({ includeDisabled: true }).length, 1);
    assert.equal(protocols.remove("p"), true);
    assert.equal(protocols.clear(), 0);
});

test("tool registry: update keeps the slot, remove and clear shrink it", (): void => {
    const tools: ToolRegistry = new ToolRegistry();
    tools.register({ name: "t", description: "one", inputSchema: { type: "object" } });
    tools.update({ name: "t", description: "two", inputSchema: { type: "object", properties: {} } });
    assert.equal(tools.get("t")?.description, "two");
    assert.equal(tools.size, 1);
    assert.throws(() => tools.update({ name: "ghost", description: "x", inputSchema: {} }), /unknown tool/);
    assert.equal(tools.remove("t"), true);
    assert.equal(tools.remove("t"), false);
    assert.equal(tools.size, 0);
    tools.register({ name: "a", description: "a", inputSchema: {} });
    tools.register({ name: "b", description: "b", inputSchema: {} });
    assert.equal(tools.clear(), 2);
});

test("outline registry: update and remove preserve strategy selection order", (): void => {
    const registry: OutlineRegistry = new OutlineRegistry();
    const make = (id: string, extension: string, tag: string) => ({
        id, strategy: id, language: id, category: "code" as const,
        matches: (input: { name: string }) => input.name.endsWith(extension),
        parse: () => [{ tag } as never],
    });
    registry.register(make("first", ".one", "a") as never);
    registry.register(make("second", ".two", "b") as never);
    registry.update(make("first", ".one", "updated") as never);
    assert.deepEqual(registry.list().map((strategy) => strategy.id), ["first", "second"]);
    assert.throws(() => registry.update(make("ghost", ".x", "g") as never), /unknown outline strategy/);
    assert.equal(registry.remove("first"), true);
    assert.deepEqual(registry.list().map((strategy) => strategy.id), ["second"]);
    assert.equal(registry.clear(), 1);
    assert.deepEqual(registry.list(), []);
});

test("outline keyword registry: update reclassifies a word and remove forgets it", (): void => {
    const keywords: OutlineKeywordRegistry = new OutlineKeywordRegistry();
    keywords.register("variable", "let");
    keywords.update("modifier", "let");
    assert.equal(keywords.categoryOf("let"), "modifier");
    assert.equal(keywords.isVariableKeyword("let"), false);
    assert.equal(keywords.remove("let"), true);
    assert.equal(keywords.remove("let"), false);
    assert.equal(keywords.categoryOf("let"), (void 0));
});

test("syntax registry: removed languages release their extensions", (): void => {
    const syntax: SyntaxRegistry = new SyntaxRegistry();
    syntax.registerLanguage({ id: "alpha", family: "code", extensions: ["aa", "ab"], lineComment: "//" });
    assert.equal(syntax.languageOf("x.aa"), "alpha");
    syntax.updateLanguage({ id: "alpha", family: "python", extensions: ["ac"] });
    assert.equal(syntax.language("alpha")?.family, "python");
    assert.equal(syntax.languageOf("x.aa"), "unknown");
    assert.equal(syntax.languageOf("x.ac"), "alpha");
    assert.equal(syntax.removeLanguage("alpha"), true);
    assert.equal(syntax.languageOf("x.ac"), "unknown");
    syntax.registerLanguage({ id: "beta", family: "code", extensions: ["ac"] });
    assert.equal(syntax.languageOf("x.ac"), "beta");
    assert.equal(syntax.clearLanguages(), 1);
    assert.equal(syntax.languageOf("x.ac"), "unknown");
    assert.equal(syntax.removeLanguage("beta"), false);
});

test("syntax registry: token and node kinds can be updated and removed", (): void => {
    const syntax: SyntaxRegistry = new SyntaxRegistry();
    syntax.registerTokenKind({ id: "kw", description: "keyword one" });
    syntax.updateTokenKind({ id: "kw", description: "keyword two" });
    assert.equal(syntax.tokenKindsList().find((kind) => kind.id === "kw")?.description, "keyword two");
    assert.equal(syntax.removeTokenKind("kw"), true);
    assert.equal(syntax.removeTokenKind("kw"), false);
    syntax.registerNodeKind({ id: "Leaf", category: "token" });
    syntax.updateNodeKind({ id: "Leaf", category: "text" });
    assert.equal(syntax.nodeKindsList().find((kind) => kind.id === "Leaf")?.category, "text");
    assert.equal(syntax.removeNodeKind("Leaf"), true);
    assert.equal(syntax.removeNodeKind("Leaf"), false);
});

test("sql dialect registry: update replaces markers and remove releases the id", (): void => {
    const dialects: SqlDialectRegistry = new SqlDialectRegistry([
        { dialect: "mysql", label: "MySQL", markers: ["AUTO_INCREMENT"] },
        { dialect: "sqlite", label: "SQLite", markers: ["PRAGMA"] },
    ]);
    dialects.update("mysql", { dialect: "mysql", label: "MySQL 2", markers: ["ENGINE"] });
    assert.equal(dialects.definitionOf("mysql")?.label, "MySQL 2");
    assert.deepEqual(dialects.dialects(), ["mysql", "sqlite"]);
    assert.equal(dialects.remove("mysql"), true);
    assert.deepEqual(dialects.dialects(), ["sqlite"]);
    assert.equal(dialects.remove("mysql"), false);
    assert.throws(() => dialects.update("sqlite", { dialect: "mysql", label: "x", markers: ["y"] }), /mismatch/);
});

test("calibration registry: a model can be replaced and dropped", (): void => {
    const calibration: CalibrationRegistry = new CalibrationRegistry();
    const model = { scope: "s", method: "raw" as const, samples: 1, rawEce: 0.1, cvEce: 0.1, thresholds: [0], values: [0], ciLower: 0, ciUpper: 0, activatedAt: "2026-01-01T00:00:00Z" };
    calibration.update(model);
    assert.equal(calibration.model("s")?.samples, 1);
    calibration.update({ ...model, samples: 7 });
    assert.equal(calibration.model("s")?.samples, 7);
    assert.equal(calibration.remove("s"), true);
    assert.equal(calibration.remove("s"), false);
    assert.equal(calibration.scopes().length, 0);
    calibration.update(model);
    assert.equal(calibration.clear(), 1);
});

test("behavior registry: rules can be replaced and removed", (): void => {
    const behaviors: BehaviorRegistry = new BehaviorRegistry([]);
    const rule = (id: string, name: string) => ({ behavior: { id, name, priority: 10, trigger: {}, policy: {}, guardrails: [], metrics: [], version: 1 }, matches: () => true } as never);
    behaviors.register(rule("b", "one"));
    behaviors.update(rule("b", "two"));
    assert.deepEqual(behaviors.list().map((behavior) => behavior.name), ["two"]);
    assert.throws(() => behaviors.update(rule("ghost", "g")), /unknown behavior/);
    assert.equal(behaviors.remove("b"), true);
    assert.equal(behaviors.remove("b"), false);
    assert.equal(behaviors.clear(), 0);
});

test("entity registry: metadata can be replaced and removed, clear still works", (): void => {
    const entities: EntityRegistry = new EntityRegistry();
    const entity = (schema: string) => ({
        name: "task", table: { name: "tasks", schema }, fields: [{ name: "id", id: true }],
    }) as never;
    entities.register(entity("one"));
    entities.update(entity("two"));
    assert.equal((entities.get("task" as never)?.table as { schema: string }).schema, "two");
    assert.throws(() => entities.update({ name: "ghost", table: { name: "ghosts" }, fields: [{ name: "id", id: true }] } as never), /no entity with this name/);
    assert.equal(entities.remove("task" as never), true);
    assert.equal(entities.has("task" as never), false);
    entities.register(entity("one"));
    entities.clear();
    assert.deepEqual(entities.names(), []);
});
