/**
 * Evidence graph: claims and the evidence that supports them.
 *
 * Edges are explicit (`evidence -> claim`), so "what supports this claim" and
 * "what would break if this evidence is withdrawn" are both one lookup. The
 * graph rejects cycles at `link` time; a warrant loop is not a proof.
 */
import { Stack } from "../structure/stack.ts";
import { UnorderedMap } from "../structure/unordered.ts";
import { UnorderedSet } from "../structure/unordered.ts";

export type EvidenceKind = "claim" | "evidence";

export interface EvidenceNode {
    id: string;
    kind: EvidenceKind;
    statement: string;
    trust?: "self" | "verified" | "trusted" | "asserted" | "inferred" | "external";
}

export class EvidenceGraph {
    private readonly nodes: UnorderedMap<string, EvidenceNode> = new UnorderedMap<string, EvidenceNode>();
    private readonly forward: UnorderedMap<string, UnorderedSet<string>> = new UnorderedMap<string, UnorderedSet<string>>();
    private readonly reverse: UnorderedMap<string, UnorderedSet<string>> = new UnorderedMap<string, UnorderedSet<string>>();

    addClaim(id: string, statement: string): EvidenceNode {
        return this.addNode({ id, kind: "claim", statement });
    }

    addEvidence(id: string, statement: string, forClaim: string, trust: EvidenceNode["trust"] = "self"): EvidenceNode {
        this.addNode({ id, kind: "evidence", statement, trust });
        this.link(id, forClaim);
        return this.nodes.get(id) as EvidenceNode;
    }

    link(from: string, to: string): void {
        if (!this.nodes.has(from) || !this.nodes.has(to)) throw new Error(`unknown evidence node ${from} -> ${to}`);
        if (from === to) throw new Error("an evidence node cannot support itself");
        this.edge(this.forward, from, to);
        this.edge(this.reverse, to, from);
        if (this.hasCycle()) {
            this.forward.get(from)?.delete(to);
            this.reverse.get(to)?.delete(from);
            throw new Error(`linking ${from} -> ${to} would create a cycle`);
        }
    }

    get(id: string): EvidenceNode | undefined {
        return this.nodes.get(id);
    }

    evidenceFor(claimId: string): string[] {
        return [...(this.reverse.get(claimId)?.values() ?? [])];
    }

    claimsFor(evidenceId: string): string[] {
        return [...(this.forward.get(evidenceId)?.values() ?? [])];
    }

    hasCycle(): boolean {
        const visiting: UnorderedSet<string> = new UnorderedSet<string>();
        const visited: UnorderedSet<string> = new UnorderedSet<string>();
        for (const id of this.nodes.keys()) {
            if (visited.has(id)) continue;
            const stack: Stack<{ id: string; next: number; neighbors: string[] }> = new Stack<{ id: string; next: number; neighbors: string[] }>();
            stack.push({ id, next: 0, neighbors: [...(this.forward.get(id)?.values() ?? [])] });
            visiting.add(id);
            while (!stack.isEmpty) {
                const frame = stack.peek();
                if (frame === undefined) break;
                if (frame.next >= frame.neighbors.length) {
                    stack.pop();
                    visiting.delete(frame.id);
                    visited.add(frame.id);
                    continue;
                }
                const next: string = frame.neighbors[frame.next];
                frame.next += 1;
                if (visiting.has(next)) return true;
                if (!visited.has(next)) {
                    visiting.add(next);
                    stack.push({ id: next, next: 0, neighbors: [...(this.forward.get(next)?.values() ?? [])] });
                }
            }
        }
        return false;
    }

    get size(): number {
        return this.nodes.size;
    }

    private addNode(node: EvidenceNode): EvidenceNode {
        if (this.nodes.has(node.id)) throw new Error(`duplicate evidence node ${node.id}`);
        this.nodes.set(node.id, node);
        return node;
    }

    private edge(map: UnorderedMap<string, UnorderedSet<string>>, from: string, to: string): void {
        let set = map.get(from);
        if (set === undefined) {
            set = new UnorderedSet<string>();
            map.set(from, set);
        }
        set.add(to);
    }
}
