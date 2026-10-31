/**
 * RFC 3339 `date-time` validation with calendar and range checks.
 *
 * `Date.parse()` is deliberately not used: it accepts date-only strings,
 * offset-less local times and legacy numeric strings, and normalizes impossible
 * dates such as `2026-02-30` into March. The construction boundary and the
 * schema validator must agree on exactly one grammar.
 */

const DateTimePattern: RegExp = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/;

const daysInMonth: (year: number, month: number) => number = (year: number, month: number): number => {
    if (month === 2) {
        const leap: boolean = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
        return leap ? 29 : 28;
    }
    return [4, 6, 9, 11].includes(month) ? 30 : 31;
};

/**
 * True for one RFC 3339 date-time with a mandatory offset.
 *
 * Leap seconds (`:60`) are accepted only at 23:59, as RFC 3339 permits.
 */
export const isDateTime: (value: unknown) => boolean = (value: unknown): boolean => {
    if (typeof(value) !== "string") {
        return false;
    }
    const match: RegExpExecArray | null = DateTimePattern.exec(value);
    if (match === null) {
        return false;
    }
    const year: number = Number(match[1]);
    const month: number = Number(match[2]);
    const day: number = Number(match[3]);
    const hour: number = Number(match[4]);
    const minute: number = Number(match[5]);
    const second: number = Number(match[6]);
    if (month < 1 || month > 12) {
        return false;
    }
    if (day < 1 || day > daysInMonth(year, month)) {
        return false;
    }
    if (hour > 23 || minute > 59 || second > 60) {
        return false;
    }
    if (second === 60 && (hour !== 23 || minute !== 59)) {
        return false;
    }
    if (match[8] !== "Z") {
        const offsetHour: number = Number(match[8].slice(1, 3));
        const offsetMinute: number = Number(match[8].slice(4, 6));
        if (offsetHour > 23 || offsetMinute > 59) {
            return false;
        }
    }
    return true;
};
