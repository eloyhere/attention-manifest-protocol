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
}

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
    if (
        protocol.capabilities !== (void 0) &&
        (!Array.isArray(protocol.capabilities) || protocol.capabilities.some((value: string): boolean => typeof(value) !== "string" || value.trim().length === 0))
    ) {
        throw new Error("protocol capabilities must contain non-empty strings");
    }
};

export class ProtocolRegistry {
    private readonly entries: InMemoryRegistry<ProtocolEntry> = new InMemoryRegistry<ProtocolEntry>(cloneProtocol, (id: string): Error => new Error(`protocol ${id} is already registered`));

    register(protocol: ProtocolEntry): ProtocolEntry {
        validateProtocol(protocol);
        return this.entries.register(protocol);
    }

    /** Replace an existing protocol. The id must stay the same. */
    update(protocol: ProtocolEntry): ProtocolEntry {
        validateProtocol(protocol);
        return this.entries.update(protocol.id, protocol);
    }

    /** Remove one protocol; the result says whether it existed. */
    remove(id: string): boolean {
        return this.entries.remove(id);
    }

    /** Remove every protocol and report how many were dropped. */
    clear(): number {
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
