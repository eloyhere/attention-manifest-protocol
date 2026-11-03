import { InMemoryRegistry } from "../registry/memory.ts";

/** Host-owned catalog of protocol metadata exposed through discovery. */
export type ProtocolStatus = "active" | "deprecated" | "disabled";

export interface ProtocolEntry {
    id: string;
    name: string;
    version: string;
    description: string;
    status?: ProtocolStatus;
    endpoint?: string;
    capabilities?: string[];
    /**
     * Protocol family this entry implements, for example `mcp` or `a2a`.
     * Discovery projects it as metadata only; it never grants execution.
     */
    family?: string;
}

/**
 * Runtime handler a protocol entry can bind to.
 *
 * The implementation is a host-supplied value: it may carry a client, a
 * transport or any other executor. The registry stores and returns it by
 * reference, so binding a protocol cannot change the entry's discoverable
 * metadata and discovery never exposes it.
 */
export type ProtocolImplementation = object;

const cloneProtocol: (protocol: ProtocolEntry) => ProtocolEntry = (protocol: ProtocolEntry): ProtocolEntry => ({
    ...protocol,
    ...(protocol.capabilities === (void 0) ? {} : { capabilities: [...protocol.capabilities] }),
});

const validateProtocol: (protocol: ProtocolEntry) => void = (protocol: ProtocolEntry): void => {
    for (const [field, value] of Object.entries({
        id: protocol.id,
        name: protocol.name,
        version: protocol.version,
        description: protocol.description,
    })) {
        if (typeof(value) !== "string" || value.trim().length === 0) {
            throw new Error(`protocol ${field} must be a non-empty string`);
        }
    }
    if (protocol.status !== (void 0) && !["active", "deprecated", "disabled"].includes(protocol.status)) {
        throw new Error(`unknown protocol status ${protocol.status}`);
    }
    if (protocol.endpoint !== (void 0) && protocol.endpoint.trim().length === 0) {
        throw new Error("protocol endpoint must be a non-empty string");
    }
    if (protocol.family !== (void 0) && protocol.family.trim().length === 0) {
        throw new Error("protocol family must be a non-empty string");
    }
    if (
        protocol.capabilities !== (void 0) &&
        (!Array.isArray(protocol.capabilities) || protocol.capabilities.some((value: string): boolean => typeof(value) !== "string" || value.trim().length === 0))
    ) {
        throw new Error("protocol capabilities must contain non-empty strings");
    }
};

export class ProtocolRegistry {
    private readonly entries: InMemoryRegistry<ProtocolEntry> = new InMemoryRegistry<ProtocolEntry>(cloneProtocol, (id: string): Error => new Error(`protocol ${id} is already registered`));
    private readonly implementations: Map<string, ProtocolImplementation> = new Map<string, ProtocolImplementation>();

    register(protocol: ProtocolEntry): ProtocolEntry {
        validateProtocol(protocol);
        return this.entries.register(protocol);
    }

    /** Replace an existing protocol. The id must stay the same. */
    update(protocol: ProtocolEntry): ProtocolEntry {
        validateProtocol(protocol);
        return this.entries.update(protocol.id, protocol);
    }

    /**
     * Bind or replace the runtime implementation of one registered protocol.
     *
     * @param id - Registered protocol id.
     * @param implementation - Host-supplied handler; stored by reference.
     * @returns The implementation.
     * @throws When the protocol id is not registered.
     */
    bind(id: string, implementation: ProtocolImplementation): ProtocolImplementation {
        if (!this.entries.has(id)) {
            throw new Error(`protocol ${id} is not registered`);
        }
        if (implementation === null || typeof(implementation) !== "object") {
            throw new TypeError("protocol implementation must be an object");
        }
        this.implementations.set(id, implementation);
        return implementation;
    }

    /**
     * Runtime implementation bound to one protocol.
     *
     * @param id - Protocol id.
     * @returns The implementation, or `undefined` when none is bound.
     */
    implementation(id: string): ProtocolImplementation | undefined {
        return this.implementations.get(id);
    }

    /**
     * Bound implementation narrowed to one known protocol type.
     *
     * @param id - Protocol id.
     * @param isProtocol - Type guard for the expected implementation.
     * @param family - Optional family that must match the entry.
     * @returns The implementation, or `undefined` when absent, unbound or of
     * another family.
     */
    resolveImplementation<T extends ProtocolImplementation>(id: string, isProtocol: (value: unknown) => value is T, family?: string): T | undefined {
        const entry: ProtocolEntry | undefined = this.entries.get(id);
        if (entry === (void 0) || (family !== (void 0) && entry.family !== family)) {
            return (void 0);
        }
        const implementation: ProtocolImplementation | undefined = this.implementations.get(id);
        return implementation !== (void 0) && isProtocol(implementation) ? implementation : (void 0);
    }

    /** Protocol ids that currently have a bound implementation. */
    bound(): string[] {
        return [...this.implementations.keys()].sort();
    }

    /** Remove one protocol and any bound implementation; says whether it existed. */
    remove(id: string): boolean {
        this.implementations.delete(id);
        return this.entries.remove(id);
    }

    /** Remove every protocol and bound implementation; reports how many entries were dropped. */
    clear(): number {
        this.implementations.clear();
        return this.entries.clear();
    }

    get(id: string): ProtocolEntry | undefined {
        return this.entries.get(id);
    }

    list(options: { includeDisabled?: boolean } = {}): ProtocolEntry[] {
        return this.entries.list({
            filter: (protocol: ProtocolEntry): boolean => options.includeDisabled === true || protocol.status !== "disabled",
            compare: (left: ProtocolEntry, right: ProtocolEntry): number => left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
        });
    }

    has(id: string): boolean {
        return this.entries.has(id);
    }
}
