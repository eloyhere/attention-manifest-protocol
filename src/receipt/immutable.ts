import { isObject } from "semantic-typescript";
import type { JsonValue } from "../shared.ts";

function freezeValue<T>(value: T): T {
    if (isObject(value) && !Object.isFrozen(value)) {
        for (const child of Object.values(value as Record<string, unknown>)) freezeValue(child);
        Object.freeze(value);
    }
    return value;
}

export function immutableSnapshot<T extends JsonValue>(value: T): Readonly<T> {
    return freezeValue(structuredClone(value));
}
