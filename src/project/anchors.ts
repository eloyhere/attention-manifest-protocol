import { WorkspaceError } from "../workspace/types.ts";
import type { AnchorRegistry } from "./types.ts";

function requireAnchor(anchor: unknown): asserts anchor is string {
    if (typeof anchor !== "string" || anchor.trim() === "") {
        throw new WorkspaceError("invalid_project", "view anchor must be nonempty text");
    }
}

/**
 * In-memory `AnchorRegistry` for hosts that do not already keep their own
 * registry. Registration order is stable, duplicates are rejected and removal
 * is idempotent (`unregisterAnchor` reports whether the anchor existed).
 *
 * The registry keeps no version or scope of its own: the owning `Project` is
 * scoped by tenant/root, so an anchor string only has to be unique inside that
 * project. Hosts that persist anchors replay them through `registerAnchor` (or
 * the `anchors` project option) after constructing the project again.
 */
export class MemoryAnchorRegistry implements AnchorRegistry {
    private readonly anchors = new Set<string>();

    constructor(initial: Iterable<string> = []) {
        for (const anchor of initial) this.registerAnchor(anchor);
    }

    registerAnchor(anchor: string): void {
        requireAnchor(anchor);
        if (this.anchors.has(anchor)) {
            throw new WorkspaceError("duplicate", `view anchor ${anchor} is already registered`);
        }
        this.anchors.add(anchor);
    }

    unregisterAnchor(anchor: string): boolean {
        requireAnchor(anchor);
        return this.anchors.delete(anchor);
    }

    resolveAnchor(anchor: string): boolean {
        return typeof anchor === "string" && this.anchors.has(anchor);
    }

    listAnchors(): readonly string[] {
        return Object.freeze([...this.anchors]);
    }
}

/** Convenience factory for the default in-memory registry. */
export function createAnchorRegistry(initial: Iterable<string> = []): AnchorRegistry {
    return new MemoryAnchorRegistry(initial);
}
