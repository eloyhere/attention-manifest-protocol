/**
 * Mission queue: a priority view over processes ready to run.
 *
 * The kernel schedules threads; this queue is the supervisor-level choice of
 * which mission to admit next. It is in-memory (a scheduler cache), backed by
 * `ProcessRepository.runnable()` when a supervisor rebuilds it.
 */
import { BinaryHeap } from "../structure/heap.ts";
import { UnorderedSet } from "../structure/unordered.ts";

export interface MissionEntry {
    pid: number;
    priority: number;
    enqueuedAt: number;
}

export class MissionQueue {
    private readonly heap: BinaryHeap<MissionEntry>;
    private readonly members: UnorderedSet<number>;
    private readonly now: () => number;

    constructor(now: () => number = () => Date.now()) {
        this.heap = new BinaryHeap<MissionEntry>({
            compare: (left, right) => {
                if (left.priority !== right.priority) {
                    return right.priority - left.priority;
                }
                if (left.enqueuedAt !== right.enqueuedAt) {
                    return left.enqueuedAt - right.enqueuedAt;
                }
                return left.pid - right.pid;
            },
        });
        this.members = new UnorderedSet<number>();
        this.now = now;
    }

    enqueue(pid: number, priority = 0): boolean {
        if (this.members.has(pid)) {
            return false;
        }
        this.members.add(pid);
        this.heap.push({ pid, priority, enqueuedAt: this.now() });
        return true;
    }

    /**
     * Pop the highest-priority live entry; stale entries are skipped.
     */
    dequeue(): number | undefined {
        while (!this.heap.isEmpty) {
            const entry: MissionEntry | undefined = this.heap.pop();
            if (entry === (void 0)) {
                return undefined;
            }
            if (this.members.has(entry.pid)) {
                this.members.delete(entry.pid);
                return entry.pid;
            }
        }
        return undefined;
    }

    remove(pid: number): boolean {
        return this.members.delete(pid);
    }

    has(pid: number): boolean {
        return this.members.has(pid);
    }

    get size(): number {
        return this.members.size;
    }
}
