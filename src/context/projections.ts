/**
 * Projections into the context AST.
 *
 * These adapters are intentionally one-way: AgentContext and ContextWindow stay
 * as they are, and the AST becomes the common view. A summary is what enters the
 * prompt; memory/body content stays behind a detail ref.
 */
import type { AgentContext } from "./agentContext.ts";
import { ContextAst } from "./ast.ts";
import type { ContextAstNode, DetailStore } from "./ast.ts";
import { MemoryDetailStore } from "./ast.ts";
import type { ContextWindow } from "../window/window.ts";

export interface AgentContextProjection {
    ast: ContextAst;
    details: DetailStore;
}

const truncate = (text: string, limit = 180): string => (text.length <= limit ? text : `${text.slice(0, limit - 3)}...`);

export const agentContextToAst = (context: AgentContext, details: DetailStore = new MemoryDetailStore()): AgentContextProjection => {
    const ast = new ContextAst();
    let order = 0;
    ast.add({
        id: "agent.context",
        kind: "goal",
        summary: `${context.profile.name} | ${context.profile.lifeChapter} | role=${context.activeRole?.role.label ?? "none"} | memories=${context.memories.length}`,
        order: order++,
        salience: 1,
    });

    const groups: Array<{ id: string; kind: ContextAstNode["kind"]; summary: string; salience: number }> = [
        { id: "agent.self", kind: "frame", summary: "self narrative and constraints", salience: 0.9 },
        { id: "agent.role", kind: "frame", summary: context.activeRole?.role.label ?? "no active role", salience: 0.8 },
        { id: "agent.affect", kind: "observation", summary: context.affect?.mood ?? "affect unknown", salience: 0.5 },
        { id: "agent.memory", kind: "frame", summary: `${context.memories.length} memories`, salience: 0.9 },
        { id: "agent.relationship", kind: "frame", summary: `${context.relationships.length} relationships`, salience: 0.4 },
        { id: "agent.membership", kind: "frame", summary: `${context.memberships.length} memberships`, salience: 0.3 },
        { id: "agent.background", kind: "observation", summary: `${context.background.length} background processes`, salience: 0.3 },
    ];
    for (const group of groups) {
        ast.add({ ...group, parentId: "agent.context", order: order++, salience: group.salience });
    }

    for (const segment of context.segments) {
        const groupId =
            segment.kind === "self"
                ? "agent.self"
                : segment.kind === "role"
                  ? "agent.role"
                  : segment.kind === "affect"
                    ? "agent.affect"
                    : segment.kind === "memory"
                      ? "agent.memory"
                      : segment.kind === "relationship"
                        ? "agent.relationship"
                        : segment.kind === "membership"
                          ? "agent.membership"
                          : "agent.background";
        ast.add({
            id: `${groupId}.segment.${order}`,
            parentId: groupId,
            kind: segment.kind === "memory" ? "observation" : "frame",
            summary: truncate(segment.text),
            order: order++,
            salience: 0.6,
        });
    }

    for (const memory of context.memories) {
        const ref = `${memory.id}`;
        details.put(ref, memory.content);
        ast.add({
            id: `agent.memory.${memory.id}`,
            parentId: "agent.memory",
            kind: "observation",
            summary: `[${memory.kind}] ${truncate(memory.content, 120)}`,
            detailRef: ref,
            detailTokens: Math.ceil(memory.content.length / 4),
            order: order++,
            salience: Math.min(1, memory.salience + 0.2),
        });
    }

    for (const relationship of context.relationships) {
        ast.add({
            id: `agent.relationship.${relationship.id}`,
            parentId: "agent.relationship",
            kind: "observation",
            summary: `${relationship.kind}: trust ${relationship.trust.toFixed(2)} attachment ${relationship.attachment.toFixed(2)}`,
            order: order++,
            salience: relationship.trust,
        });
    }
    for (const membership of context.memberships) {
        ast.add({
            id: `agent.membership.${membership.institution.id}`,
            parentId: "agent.membership",
            kind: "observation",
            summary: `${membership.institution.name}: ${membership.role} (${membership.status})`,
            order: order++,
            salience: 0.4,
        });
    }
    for (const process of context.background) {
        ast.add({
            id: `agent.background.${process.id}`,
            parentId: "agent.background",
            kind: "observation",
            summary: `${process.kind}: ${process.label} intensity=${process.intensity.toFixed(2)}`,
            order: order++,
            salience: process.intensity,
        });
    }

    // Root -> groups; role -> memory is a support edge, not containment.
    for (const group of groups.slice(1)) {
        ast.link({ from: "agent.context", to: group.id, kind: "before" });
    }
    ast.link({ from: "agent.role", to: "agent.memory", kind: "supports" });
    return { ast, details };
};

/** Project a paged window; page content is the summary, page id is the ref. */
export const windowToAst = (window: ContextWindow): ContextAst => {
    const ast = new ContextAst();
    ast.add({
        id: "window",
        kind: "goal",
        summary: `${window.entries().length} resident pages, ${window.usedTokens}/${window.capacityTokens} tokens`,
        order: 0,
        salience: 1,
    });
    let order = 1;
    for (const page of window.entries()) {
        const summary = page.content === (void 0) ? `${page.objectKind}:${page.objectId}` : truncate(JSON.stringify(page.content), 160);
        ast.add({
            id: `window.page.${page.id}`,
            parentId: "window",
            kind: "observation",
            summary,
            detailRef: page.id,
            detailTokens: page.tokens,
            order: order++,
            salience: page.pinned > 0 ? 1 : 0.5,
        });
    }
    return ast;
};
