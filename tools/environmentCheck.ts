#!/usr/bin/env node
/** Environment directory and host catalog regression checks. */
import assert from "node:assert/strict";
import test from "node:test";
import { HostCatalog } from "../src/discover/host.ts";
import type { HostComponent, HostProject } from "../src/discover/types.ts";
import { EnvironmentAvailabilities, EnvironmentCategories, getDefaultEnvironments, loadDefaultEnvironments } from "../src/environment/index.ts";

const component: (id?: string) => HostComponent = (id: string = "host.module"): HostComponent => ({
    id, kind: "module", name: "Host module", description: "A host-owned component.",
});
const ArrayFields = ["capabilities", "platforms", "extensions", "relatedIds", "skillIds", "knowledgeIds", "toolIds", "protocolIds"] as const;

test("defaults contain all four environment categories and the required stable IDs", () => {
    const defaults = getDefaultEnvironments();
    assert.deepEqual(EnvironmentCategories, ["runtime", "application", "language", "projectType"]);
    assert.deepEqual(EnvironmentAvailabilities, ["unknown", "available", "unavailable"]);
    assert.deepEqual(new Set(defaults.map((entry) => entry.category)), new Set(EnvironmentCategories));
    const ids = new Set(defaults.map((entry) => entry.id));
    assert.equal(ids.size, defaults.length);
    for (const id of [
        "runtime.powershell7", "runtime.powershell5", "runtime.sh", "runtime.bash", "runtime.zsh",
        "application.word", "application.excel", "application.powerpoint", "application.publisher", "application.access", "application.project",
        "language.c", "language.cpp", "language.java", "language.python", "language.javascript", "language.typescript", "language.csharp", "language.go", "language.rust",
        "projectType.npm", "projectType.maven", "projectType.gradle", "projectType.cmake", "projectType.cargo", "projectType.go", "projectType.python", "projectType.dotnet",
    ]) {
        assert.ok(ids.has(id), `missing ${id}`);
    }
    for (const entry of defaults) {
        assert.equal(entry.kind, "module");
        assert.equal(entry.availability, "unknown");
        assert.equal(entry.endpoint, undefined);
        assert.equal(entry.status, undefined);
        for (const relatedId of entry.relatedIds ?? []) {
            assert.ok(ids.has(relatedId), `${entry.id} references undefined environment ${relatedId}`);
        }
        for (const field of ["skillIds", "knowledgeIds", "toolIds", "protocolIds"] as const) {
            assert.equal(entry[field], undefined);
        }
    }
    assert.equal(defaults.find((entry) => entry.id === "runtime.powershell5")?.version, "5.1");
    assert.equal(defaults.find((entry) => entry.id === "runtime.powershell7")?.version, undefined);
});

test("default values are independent across objects and successive calls", () => {
    const first = getDefaultEnvironments();
    const second = getDefaultEnvironments();
    for (let index = 0; index < first.length; index += 1) {
        assert.notEqual(first[index], second[index]);
        for (const field of ArrayFields) {
            if (first[index][field] !== undefined) {
                assert.notEqual(first[index][field], second[index][field]);
                first[index][field]!.push("mutated");
                assert.ok(!second[index][field]!.includes("mutated"));
            }
        }
    }
    first[0].name = "changed";
    assert.notEqual(getDefaultEnvironments()[0].name, "changed");
    assert.deepEqual(getDefaultEnvironments(), second);
});

test("loading is explicit, idempotent and preserves arbitrary host overrides", () => {
    const catalog = new HostCatalog();
    assert.deepEqual(catalog.components(), []);
    catalog.addTool({ ...component("runtime.powershell7"), name: "Host execution tool", capabilities: ["execute"] });
    catalog.addModule({ ...component("application.word"), availability: "available", category: "application", version: "host-known", toolIds: ["host.word"] });
    const overridden = catalog.components();
    const added = loadDefaultEnvironments(catalog);
    assert.equal(added.length, getDefaultEnvironments().length - 2);
    assert.deepEqual(catalog.components().slice(0, 2), overridden);
    assert.ok(!added.some((entry) => entry.id === "runtime.powershell7" || entry.id === "application.word"));
    assert.deepEqual(loadDefaultEnvironments(catalog), []);
    assert.equal(catalog.components().length, getDefaultEnvironments().length);
    assert.deepEqual(catalog.getComponent("runtime.powershell7"), overridden[0]);
    assert.deepEqual(catalog.getComponent("application.word"), overridden[1]);
    assert.equal(catalog.getComponent("missing"), undefined);
    added[0].name = "changed";
    added[0].extensions?.push(".changed");
    assert.notEqual(catalog.getComponent(added[0].id)?.name, "changed");
    assert.ok(!catalog.getComponent(added[0].id)?.extensions?.includes(".changed"));
});

test("host component metadata is cloned at every registry boundary", () => {
    const catalog = new HostCatalog();
    const input = component();
    input.category = "runtime";
    input.availability = "available";
    for (const field of ArrayFields) {
        input[field] = [field];
    }
    const returned = catalog.addComponent(input);
    const listed = catalog.components()[0];
    const fetched = catalog.getComponent(input.id)!;
    for (const field of ArrayFields) {
        input[field]!.push("input mutation");
        returned[field]!.push("return mutation");
        listed[field]!.push("list mutation");
        fetched[field]!.push("get mutation");
        assert.deepEqual(catalog.getComponent(input.id)![field], [field]);
    }
    returned.availability = "unavailable";
    assert.equal(catalog.getComponent(input.id)?.availability, "available");
});

test("invalid environment enum values and string arrays are rejected", () => {
    const catalog = new HostCatalog();
    for (const category of ["shell", "", null, 1]) {
        assert.throws(() => catalog.addComponent({ ...component(), category } as unknown as HostComponent), /unknown discovery component category/);
    }
    for (const availability of ["installed", "", null, 1]) {
        assert.throws(() => catalog.addComponent({ ...component(), availability } as unknown as HostComponent), /unknown discovery component availability/);
    }
    for (const field of ArrayFields) {
        for (const invalid of ["text", null, {}, [""], [" "], [1], [null], Array(1)]) {
            assert.throws(() => catalog.addComponent({ ...component(), [field]: invalid } as HostComponent), new RegExp(`discovery component ${field} must be non-empty strings`));
        }
    }
    assert.deepEqual(catalog.components(), []);
    for (const category of EnvironmentCategories) {
        for (const availability of EnvironmentAvailabilities) {
            catalog.addComponent({ ...component(`${category}.${availability}`), category, availability, platforms: [] });
        }
    }
    assert.equal(catalog.components().length, EnvironmentCategories.length * EnvironmentAvailabilities.length);
});

test("legacy host APIs retain validation, duplicate errors, filtering and insertion order", () => {
    const catalog = new HostCatalog();
    const project: HostProject = { id: "project.one", name: "One", description: "Project", purpose: "Test", summary: "Summary", tags: ["original"] };
    const returned = catalog.addProject(project);
    project.tags!.push("input mutation");
    returned.tags!.push("return mutation");
    catalog.projects()[0].tags!.push("list mutation");
    assert.deepEqual(catalog.projects()[0].tags, ["original"]);
    assert.equal(catalog.hasProject(project.id), true);
    assert.equal(catalog.hasProject("missing"), false);
    assert.throws(() => catalog.addProject(project), { message: "project project.one is already registered" });
    catalog.addProject({ ...project, id: "project.two" });
    assert.deepEqual(catalog.projects().map((entry) => entry.id), ["project.one", "project.two"]);
    catalog.addPlugin(component("plugin"));
    catalog.addService(component("service"));
    catalog.addTool(component("tool"));
    catalog.addModule(component("module"));
    assert.deepEqual(catalog.components().map((entry) => entry.id), ["plugin", "service", "tool", "module"]);
    for (const kind of ["plugin", "service", "tool", "module"] as const) {
        assert.equal(catalog.hasComponent(kind), true);
        assert.deepEqual(catalog.components(kind).map((entry) => entry.id), [kind]);
        assert.throws(() => catalog.addComponent({ ...component(kind), kind }), { message: `component ${kind} is already registered` });
    }
    assert.equal(catalog.hasComponent("missing"), false);
    assert.throws(() => catalog.addComponent({ ...component("bad"), kind: "invalid" } as unknown as HostComponent), { message: "unknown discovery component kind invalid" });
    assert.throws(() => catalog.addComponent({ ...component("bad"), status: "invalid" } as unknown as HostComponent), { message: "unknown discovery component status invalid" });
    assert.throws(() => catalog.addComponent({ ...component("bad"), endpoint: " " }), { message: "discovery component endpoint must be a non-empty string" });
    assert.throws(() => catalog.addComponent({ ...component("bad"), name: " " }), { message: "discovery component name must be a non-empty string" });
    assert.throws(() => catalog.addProject({ ...project, rootId: " " }), { message: "discovery project rootId must be a non-empty string" });
    assert.throws(() => catalog.addProject({ ...project, tags: [" "] }), { message: "discovery project tags must be non-empty strings" });
});
