/**
 * Window errors: the context window cannot hold a page even after eviction.
 */
import { AmpError } from "./ampError.ts";

export type WindowCode = "window_full" | "unknown_page";

export class WindowError extends AmpError<WindowCode> {
    constructor(code: WindowCode, problems: readonly string[]) {
        super("WindowError", code, problems);
    }
}
