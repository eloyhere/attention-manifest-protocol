/**
 * Sandbox port. The reference implementation has no secure sandbox, so the
 * default policy is to refuse; a host that has one implements this interface.
 * `DeniedSandbox` exists to make the absence explicit instead of pretending a
 * `child_process` call is isolation.
 */
export interface SandboxCommand {
    command: string;
    args?: string[];
    cwd?: string;
    timeoutMs?: number;
}

export interface SandboxResult {
    code: number;
    stdout: string;
    stderr: string;
    timedOut: boolean;
}

export interface Sandbox {
    run(command: SandboxCommand): Promise<SandboxResult>;
}

export class DeniedSandbox implements Sandbox {
    async run(_command: SandboxCommand): Promise<SandboxResult> {
        throw new Error("sandbox_unavailable: no secure sandbox is configured");
    }
}
