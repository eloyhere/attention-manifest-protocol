#!/usr/bin/env node
/** Conservative behavior priority suggestions from conflict counts. */
import assert from "node:assert/strict";

import { DEFAULT_BEHAVIORS } from "../src/runtime/behavior.ts";
import { BehaviorRegistry } from "../src/runtime/behavior.ts";
import { applyPrioritySuggestions, BehaviorTuningController, rollbackPrioritySuggestions, suggestPriorityTuning } from "../src/runtime/behaviorTuning.ts";

const behaviors = DEFAULT_BEHAVIORS.map((rule) => rule.behavior);
const suggestions = suggestPriorityTuning(behaviors, {
    "affect_then_converge<-clarify_when_uncertain": 5,
    "affect_then_converge<-no_diagnosis": 5,
});
const affect = suggestions.find((entry) => entry.behaviorId === "affect_then_converge");
const clarify = suggestions.find((entry) => entry.behaviorId === "clarify_when_uncertain");
assert.ok(affect);
assert.ok(clarify);
assert.equal(affect.suggested, 82);
assert.equal(clarify.suggested, 74);
assert.equal(
    suggestions.some((entry) => entry.behaviorId === "no_diagnosis"),
    false,
);

const ignored = suggestPriorityTuning(behaviors, { "affect_then_converge<-clarify_when_uncertain": 1 }, { threshold: 3 });
assert.equal(ignored.length, 0);

const tuned = applyPrioritySuggestions(behaviors, suggestions);
assert.equal(tuned.find((entry) => entry.id === "affect_then_converge")?.priority, 82);
assert.equal(tuned.find((entry) => entry.id === "clarify_when_uncertain")?.priority, 74);
assert.equal(behaviors.find((entry) => entry.id === "affect_then_converge")?.priority, 80);
const restored = rollbackPrioritySuggestions(tuned, behaviors);
assert.equal(restored.find((entry) => entry.id === "affect_then_converge")?.priority, 80);
assert.equal(restored.find((entry) => entry.id === "clarify_when_uncertain")?.priority, 75);

const registry = new BehaviorRegistry();
const controller = new BehaviorTuningController(registry);
const disabled = controller.autoApply({ "affect_then_converge<-clarify_when_uncertain": 5 }, { enabled: false });
assert.equal(disabled.applied, 0);
assert.equal(registry.list().find((entry) => entry.id === "affect_then_converge")?.priority, 80);
const enabled = controller.autoApply({ "affect_then_converge<-clarify_when_uncertain": 5 }, { enabled: true });
assert.equal(enabled.applied, 2);
assert.equal(registry.list().find((entry) => entry.id === "affect_then_converge")?.priority, 81);
assert.equal(controller.autoApply({ "affect_then_converge<-clarify_when_uncertain": 5 }, { enabled: true }).applied, 0);
assert.equal(controller.rollback(enabled.version), true);
assert.equal(registry.list().find((entry) => entry.id === "affect_then_converge")?.priority, 80);

console.log("\x1b[32m✓\x1b[0m conflict statistics produce bounded, review-only priority suggestions; hard guardrails are not lowered");
console.log("\x1b[32m✓\x1b[0m apply/rollback returns copies without mutating the original behaviors");
console.log("\x1b[32m✓\x1b[0m opt-in tuning applies once and rolls back to the prior priorities");
console.log("\n1 passed, 0 failed");
