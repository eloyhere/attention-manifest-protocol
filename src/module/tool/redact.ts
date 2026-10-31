/**
 * Redact common secret shapes from tool results before they enter the model
 * context, receipt, or outbox. This is a safety net, not a DLP system.
 */
export interface Redaction {
    text: string;
    redacted: boolean;
}

const Patterns: RegExp[] = [
    /\bsk-[A-Za-z0-9_-]{16,}\b/g,
    /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi,
    /\bAKIA[0-9A-Z]{16}\b/g,
    /\b(?:password|passwd|secret|token)\s*[:=]\s*["']?[^\s"',;]{6,}/gi,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

export const redactSecrets: (text: string) => Redaction = (text: string): Redaction => {
    let redacted: boolean = false;
    let output: string = text;
    for (let i: number = 0; i < Patterns.length; i += 1) {
        const pattern: RegExp = Patterns[i];
        output = output.replace(pattern, () => {
            redacted = true;
            return "[REDACTED]";
        });
    }
    return { text: output, redacted };
};
