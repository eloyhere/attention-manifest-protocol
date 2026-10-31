/**
 * Strict I-JSON value inspection.
 *
 * `canonical()`, the construction boundary and the persistence layers all need
 * one definition of "this value can be represented as JSON". JavaScript values
 * outside that domain (`undefined`, `NaN`, functions, `Date`, sparse arrays,
 * cycles) must be rejected instead of being silently rewritten by
 * `JSON.stringify`, because a digest that covers a rewritten value no longer
 * binds what the caller passed.
 */

const constructorName: (value: object) => string = (value: object): string => {
    const prototype: object | null = Object.getPrototypeOf(value);
    if (prototype === null) {
        return "null-prototype object";
    }
    const name: unknown = (prototype as { constructor?: { name?: unknown } }).constructor?.name;
    return typeof(name) === "string" && name.length > 0 ? name : "object";
};

const problemAt: (value: unknown, at: string, seen: Set<object>) => string | undefined = (
    value: unknown,
    at: string,
    seen: Set<object>,
): string | undefined => {
    if (value === null) {
        return (void 0);
    }
    const kind: string = typeof(value);
    if (kind === "string" || kind === "boolean") {
        return (void 0);
    }
    if (kind === "number") {
        return Number.isFinite(value as number) ? (void 0) : `${at} is not a finite number`;
    }
    if (kind === "undefined") {
        return `${at} is undefined`;
    }
    if (kind === "bigint" || kind === "function" || kind === "symbol") {
        return `${at} is a ${kind}`;
    }
    const object: object = value as object;
    if (seen.has(object)) {
        return `${at} contains a cycle`;
    }
    seen.add(object);
    try {
        if (Array.isArray(value)) {
            for (let index: number = 0; index < value.length; index += 1) {
                if (!(index in value)) {
                    return `${at}[${index}] is a hole`;
                }
                const problem: string | undefined = problemAt(value[index], `${at}[${index}]`, seen);
                if (problem !== (void 0)) {
                    return problem;
                }
            }
            return (void 0);
        }
        const prototype: object | null = Object.getPrototypeOf(object);
        if (prototype !== null && prototype !== Object.prototype) {
            return `${at} is a ${constructorName(object)}, not a plain object`;
        }
        if (Object.getOwnPropertySymbols(object).length > 0) {
            return `${at} has symbol keys`;
        }
        const keys: string[] = Object.keys(object);
        for (let index: number = 0; index < keys.length; index += 1) {
            const key: string = keys[index];
            const descriptor: PropertyDescriptor | undefined = Object.getOwnPropertyDescriptor(object, key);
            if (descriptor === (void 0) || !("value" in descriptor)) {
                return `${at}.${key} is an accessor`;
            }
            const problem: string | undefined = problemAt(descriptor.value, `${at}.${key}`, seen);
            if (problem !== (void 0)) {
                return problem;
            }
        }
        return (void 0);
    } finally {
        seen.delete(object);
    }
};

/**
 * Describe why `value` is not I-JSON, or `undefined` when it is.
 */
export const jsonValueProblem: (value: unknown, at?: string) => string | undefined = (
    value: unknown,
    at: string = "$",
): string | undefined => problemAt(value, at, new Set<object>());

/**
 * True when the value is exactly representable as JSON without rewriting.
 */
export const isJsonValue: (value: unknown) => boolean = (value: unknown): boolean => jsonValueProblem(value) === (void 0);

/**
 * Throw a `TypeError` naming the first non-JSON path.
 */
export const assertJsonValue: (value: unknown, at?: string) => void = (value: unknown, at: string = "$"): void => {
    const problem: string | undefined = jsonValueProblem(value, at);
    if (problem !== (void 0)) {
        throw new TypeError(problem);
    }
};

/**
 * Deep-copy a JSON value. Asserts first, so the result cannot contain values
 * that `JSON.stringify` would drop or rewrite.
 */
export const cloneJson: <T>(value: T) => T = <T>(value: T): T => {
    assertJsonValue(value);
    return JSON.parse(JSON.stringify(value)) as T;
};

/**
 * Recursively freeze a JSON value. Assumes the value is acyclic (assert first).
 */
export const deepFreezeJson: <T>(value: T) => T = <T>(value: T): T => {
    const freeze: (item: unknown) => void = (item: unknown): void => {
        if (item === null || typeof(item) !== "object" || Object.isFrozen(item)) {
            return;
        }
        Object.freeze(item);
        if (Array.isArray(item)) {
            item.forEach(freeze);
        } else {
            Object.keys(item).forEach((key: string) => freeze((item as Record<string, unknown>)[key]));
        }
    };
    freeze(value);
    return value;
};
