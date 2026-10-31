/**
 * Evidence graph: claims and the evidence that supports them.
 *
 * Edges are explicit (`evidence -> claim`), so "what supports this claim" and
 * "what directly depends on this evidence" are both one lookup. Transitive
 * impact uses a bounded traversal of the reachable component. The
 * graph rejects cycles at `link` time; a warrant loop is not a proof.
 */
import { Stack } from "../structure/stack.ts";
import { Queue } from "../structure/queue.ts";
import { UnorderedMap } from "../structure/unordered.ts";
import { UnorderedSet } from "../structure/unordered.ts";

export type EvidenceKind = "claim" | "evidence";

export interface EvidenceNode {
    readonly id: string;
    readonly kind: EvidenceKind;
    statement: string;
    trust?: "self" | "verified" | "trusted" | "asserted" | "inferred" | "external";
}

export interface EvidenceImpact {
    id: string;
    /**
     * One shortest dependency witness; null denotes an explicitly changed root.
     */
    via: string | null;
}

/**
 * One depth-first search frame used by cycle detection.
 */
type SearchFrame = {
    id: string;
    next: number;
    neighbors: string[];
};

export class EvidenceGraph {
    private readonly nodes: UnorderedMap<string, EvidenceNode> = new UnorderedMap<string, EvidenceNode>();
    private readonly forward: UnorderedMap<string, UnorderedSet<string>> = new UnorderedMap<string, UnorderedSet<string>>();
    private readonly reverse: UnorderedMap<string, UnorderedSet<string>> = new UnorderedMap<string, UnorderedSet<string>>();

    addClaim(id: string, statement: string): EvidenceNode {
        return this.addNode({ id, kind: "claim", statement });
    }

    addEvidence(id: string, statement: string, forClaim: string, trust: EvidenceNode["trust"] = "self"): EvidenceNode {
        if (!this.nodes.has(forClaim)) {
            throw new Error(`unknown evidence node ${forClaim}`);
        }
        this.addSource(id, statement, trust);
        this.link(id, forClaim);
        return this.nodes.get(id) as EvidenceNode;
    }

    addSource(id: string, statement: string, trust: EvidenceNode["trust"] = "self"): EvidenceNode {
        return this.addNode({ id, kind: "evidence", statement, trust });
    }

    link(from: string, to: string): void {
        if (!this.nodes.has(from) || !this.nodes.has(to)) {
            throw new Error(`unknown evidence node ${from} -> ${to}`);
        }
        if (from === to) {
            throw new Error("an evidence node cannot support itself");
        }
        if (this.forward.get(from)?.has(to)) {
            return;
        }
        if (this.reaches(to, from)) {
            throw new Error(`linking ${from} -> ${to} would create a cycle`);
        }
        this.edge(this.forward, from, to);
        this.edge(this.reverse, to, from);
    }

    /**
     * Multi-source breadth-first impact closure, including the changed roots.
     * Visits only reachable adjacency, once per node, in container iteration order.
     * This is a review set, not a verdict that dependent claims are false.
     */
    impact(changedIds: readonly string[]): EvidenceImpact[] {
        changedIds.forEach((id: string) => {
            if (!this.nodes.has(id)) {
                throw new Error(`unknown evidence node ${id}`);
            }
        });
        const visited: Set<string> = new Set<string>();
        const queue: Queue<EvidenceImpact> = new Queue<EvidenceImpact>();
        const result: EvidenceImpact[] = [];
        changedIds.forEach((id: string) => {
            if (!visited.has(id)) {
                visited.add(id);
                queue.enqueue({ id, via: null });
            }
        });
        while (!queue.isEmpty) {
            const entry: EvidenceImpact = queue.dequeue() as EvidenceImpact;
            result.push(entry);
            const neighbors: string[] = [...(this.forward.get(entry.id)?.values() ?? [])];
            neighbors.forEach((id: string) => {
                if (!visited.has(id)) {
                    visited.add(id);
                    queue.enqueue({ id, via: entry.id });
                }
            });
        }
        return result;
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
        const ids: string[] = [...this.nodes.keys()];
        for (let index: number = 0; index < ids.length; index += 1) {
            const id: string = ids[index];
            if (visited.has(id)) {
                continue;
            }
            const stack: Stack<SearchFrame> = new Stack<SearchFrame>();
            stack.push({ id, next: 0, neighbors: [...(this.forward.get(id)?.values() ?? [])] });
            visiting.add(id);
            while (!stack.isEmpty) {
                const frame: SearchFrame | undefined = stack.peek();
                if (frame === (void 0)) {
                    break;
                }
                if (frame.next >= frame.neighbors.length) {
                    stack.pop();
                    visiting.delete(frame.id);
                    visited.add(frame.id);
                    continue;
                }
                const next: string = frame.neighbors[frame.next];
                frame.next += 1;
                if (visiting.has(next)) {
                    return true;
                }
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
        if (this.nodes.has(node.id)) {
            throw new Error(`duplicate evidence node ${node.id}`);
        }
        Object.defineProperty(node, "id", { writable: false, configurable: false });
        Object.defineProperty(node, "kind", { writable: false, configurable: false });
        this.nodes.set(node.id, node);
        return node;
    }

    private reaches(start: string, target: string): boolean {
        const stack: Stack<string> = new Stack<string>();
        const visited: Set<string> = new Set<string>();
        stack.push(start);
        visited.add(start);
        while (!stack.isEmpty) {
            const id: string = stack.pop() as string;
            if (id === target) {
                return true;
            }
            const neighbors: string[] = [...(this.forward.get(id)?.values() ?? [])];
            neighbors.forEach((next: string) => {
                if (!visited.has(next)) {
                    visited.add(next);
                    stack.push(next);
                }
            });
        }
        return false;
    }

    private edge(map: UnorderedMap<string, UnorderedSet<string>>, from: string, to: string): void {
        let set: UnorderedSet<string> | undefined = map.get(from);
        if (set === (void 0)) {
            set = new UnorderedSet<string>();
            map.set(from, set);
        }
        set.add(to);
    }
}
