/**
 * Redact common secret shapes from tool results before they enter the model
 * context, receipt, or outbox. This is a safety net, not a DLP system.
 */
export interface Redaction {
    text: string;
    redacted: boolean;
}

const patterns: RegExp[] = [
    /\bsk-[A-Za-z0-9_-]{16,}\b/g,
    /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi,
    /\bAKIA[0-9A-Z]{16}\b/g,
    /\b(?:password|passwd|secret|token)\s*[:=]\s*["']?[^\s"',;]{6,}/gi,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

export const redactSecrets = (text: string): Redaction => {
    let redacted = false;
    let output = text;
    for (const pattern of patterns) {
        output = output.replace(pattern, () => {
            redacted = true;
            return "[REDACTED]";
        });
    }
    return { text: output, redacted };
};
