/**
 * Character trie (prefix tree).
 *
 * Used where a hash map cannot answer "which keys start with this prefix?":
 * outline symbol lookup, root-relative path prefixes and import specifier
 * completion. Keys are JavaScript strings; children use a `Map` rather than a
 * fixed alphabet so Unicode identifiers work without a 65k-entry node.
 *
 * The trie is a mutable index, not a source of truth. `insert` replaces the
 * value at an existing terminal; `delete` removes the terminal and prunes the
 * now-empty path. Traversal is iterative so a pathological key length cannot
 * exhaust the call stack.
 */

/**
 * One trie node. `terminal` is tracked separately from `value` because a key
 * may legitimately store `undefined`; `has` must still distinguish "present
 * with no value" from "absent".
 */
export interface TrieNode<T> {
    readonly children: Map<string, TrieNode<T>>;
    terminal: boolean;
    value?: T;
}

const createNode: <T>() => TrieNode<T> = <T>(): TrieNode<T> => ({ children: new Map<string, TrieNode<T>>(), terminal: false });

/**
 * A prefix tree over string keys.
 *
 * @typeParam T - Value stored at a terminal key.
 */
export class Trie<T> {
    private readonly root: TrieNode<T> = createNode<T>();
    private count: number = 0;

    /**
     * Number of terminal keys.
     */
    get size(): number {
        return this.count;
    }

    /**
     * Insert or replace one key.
     *
     * @param key - Non-empty key.
     * @param value - Value stored at the terminal.
     */
    insert(key: string, value: T): void {
        if (key.length === 0) {
            throw new RangeError("trie key must not be empty");
        }
        let node: TrieNode<T> = this.root;
        for (let index: number = 0; index < key.length; index += 1) {
            const character: string = key[index];
            let child: TrieNode<T> | undefined = node.children.get(character);
            if (child === (void 0)) {
                child = createNode<T>();
                node.children.set(character, child);
            }
            node = child;
        }
        if (!node.terminal) {
            this.count += 1;
        }
        node.terminal = true;
        node.value = value;
    }

    /**
     * Read a key's value. The second element distinguishes "absent" from
     * "present with an `undefined` value".
     *
     * @param key - Key to locate.
     * @returns Found state and value.
     */
    find(key: string): { found: boolean; value?: T; } {
        let node: TrieNode<T> | undefined = this.root;
        for (let index: number = 0; index < key.length; index += 1) {
            node = node.children.get(key[index]);
            if (node === (void 0)) {
                return { found: false };
            }
        }
        return node.terminal ? { found: true, value: node.value } : { found: false };
    }

    /**
     * Value at a terminal key, or `undefined`.
     */
    get(key: string): T | undefined {
        return this.find(key).value;
    }

    /**
     * Whether a key is present.
     */
    has(key: string): boolean {
        return this.find(key).found;
    }

    /**
     * Remove one key. Returns `false` when the key was absent.
     */
    delete(key: string): boolean {
        if (key.length === 0) {
            return false;
        }
        const path: Array<{ character: string; node: TrieNode<T>; }> = [];
        let node: TrieNode<T> | undefined = this.root;
        for (let index: number = 0; index < key.length; index += 1) {
            const character: string = key[index];
            const child: TrieNode<T> | undefined = node.children.get(character);
            if (child === (void 0)) {
                return false;
            }
            path.push({ character, node });
            node = child;
        }
        if (!node.terminal) {
            return false;
        }
        node.terminal = false;
        delete node.value;
        this.count -= 1;
        for (let index: number = path.length - 1; index >= 0; index -= 1) {
            const edge: { character: string; node: TrieNode<T>; } = path[index];
            const child: TrieNode<T> | undefined = edge.node.children.get(edge.character);
            if (child === (void 0) || child.terminal || child.children.size > 0) {
                break;
            }
            edge.node.children.delete(edge.character);
        }
        return true;
    }

    /**
     * All terminal keys under a prefix, in insertion-independent lexical order.
     *
     * @param prefix - Optional prefix; empty returns every key.
     */
    keys(prefix: string = ""): string[] {
        return this.entries(prefix).map((entry: readonly [string, T]): string => entry[0]);
    }

    /**
     * All terminal entries under a prefix.
     */
    entries(prefix: string = ""): Array<readonly [string, T]> {
        let start: TrieNode<T> | undefined = this.root;
        for (let index: number = 0; index < prefix.length; index += 1) {
            start = start.children.get(prefix[index]);
            if (start === (void 0)) {
                return [];
            }
        }
        const result: Array<readonly [string, T]> = [];
        const stack: Array<{ key: string; node: TrieNode<T>; }> = [{ key: prefix, node: start }];
        while (stack.length > 0) {
            const current: { key: string; node: TrieNode<T>; } = stack.pop()!;
            if (current.node.terminal) {
                result.push([current.key, current.node.value as T]);
            }
            const characters: string[] = [...current.node.children.keys()].reverse();
            for (let index: number = 0; index < characters.length; index += 1) {
                const character: string = characters[index];
                const child: TrieNode<T> | undefined = current.node.children.get(character);
                if (child !== (void 0)) {
                    stack.push({ key: current.key + character, node: child });
                }
            }
        }
        result.sort((left: readonly [string, T], right: readonly [string, T]): number => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));
        return result;
    }

    /**
     * Longest terminal prefix of `text`, useful for matching a selector or a
     * path against a known set without generating every prefix.
     */
    longestPrefix(text: string): { key: string; value: T; } | undefined {
        let node: TrieNode<T> | undefined = this.root;
        let match: { key: string; value: T; } | undefined = (void 0);
        for (let index: number = 0; index < text.length; index += 1) {
            node = node.children.get(text[index]);
            if (node === (void 0)) {
                break;
            }
            if (node.terminal) {
                match = { key: text.slice(0, index + 1), value: node.value as T };
            }
        }
        return match;
    }

    /**
     * Remove every key.
     */
    clear(): void {
        this.root.children.clear();
        this.root.terminal = false;
        delete this.root.value;
        this.count = 0;
    }
}
