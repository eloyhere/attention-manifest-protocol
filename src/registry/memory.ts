/** Small in-memory registry primitive with defensive cloning. */
export interface InMemoryRegistryListOptions<T> {
    filter?: (entry: T) => boolean;
    compare?: (left: T, right: T) => number;
}

export class InMemoryRegistry<T extends { id: string }> {
    private readonly entries: Map<string, T> = new Map<string, T>();
    private readonly cloneEntry: (entry: T) => T;
    private readonly duplicateError: (id: string) => Error;

    constructor(cloneEntry: (entry: T) => T, duplicateError: (id: string) => Error) {
        this.cloneEntry = cloneEntry;
        this.duplicateError = duplicateError;
    }

    register(entry: T): T {
        if (this.entries.has(entry.id)) {
            throw this.duplicateError(entry.id);
        }
        const stored: T = this.cloneEntry(entry);
        this.entries.set(stored.id, stored);
        return this.cloneEntry(stored);
    }

    /**
     * Replace an existing entry in place, keeping its id.
     *
     * @param id - Id of the entry to replace; must already exist.
     * @param entry - Complete replacement entry.
     * @returns The stored copy.
     * @throws When the id is absent or the replacement names a different id.
     */
    update(id: string, entry: T): T {
        if (id !== entry.id) {
            throw new Error(`registry entry id ${entry.id} does not match ${id}`);
        }
        if (!this.entries.has(id)) {
            throw new Error(`registry entry ${id} is not registered`);
        }
        const stored: T = this.cloneEntry(entry);
        this.entries.set(stored.id, stored);
        return this.cloneEntry(stored);
    }

    /**
     * Remove one entry.
     *
     * @param id - Entry id.
     * @returns `true` when an entry was removed.
     */
    remove(id: string): boolean {
        return this.entries.delete(id);
    }

    /**
     * Drop every entry.
     *
     * @returns Number of removed entries.
     */
    clear(): number {
        const count: number = this.entries.size;
        this.entries.clear();
        return count;
    }

    get(id: string): T | undefined {
        const entry: T | undefined = this.entries.get(id);
        return entry === (void 0) ? undefined : this.cloneEntry(entry);
    }

    list(options: InMemoryRegistryListOptions<T> = {}): T[] {
        const entries: T[] = [...this.entries.values()]
            .filter((entry: T): boolean => options.filter === (void 0) || options.filter(entry))
            .map(this.cloneEntry);
        if (options.compare !== (void 0)) {
            entries.sort(options.compare);
        }
        return entries;
    }

    has(id: string): boolean {
        return this.entries.has(id);
    }
}
