import { AmpError } from "./ampError.ts";

export type MailboxCode = "mailbox_full" | "unknown_message" | "unknown_recipient";

export class MailboxError extends AmpError<MailboxCode> {
    constructor(code: MailboxCode, problems: readonly string[]) {
        super("MailboxError", code, problems);
    }
}
