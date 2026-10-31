/**
 * Tool port and registry. MCP is one executor behind this interface; a local
 * function or a sandboxed shell can be another without touching the kernel.
 */
import { UnorderedMap } from "../../structure/unordered.ts";

export type ToolRisk = "read" | "write" | "destructive";

export interface ToolDescriptor {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    risk?: ToolRisk;
}

export interface ToolInvocation {
    tool: string;
    args: Record<string, unknown>;
}

export interface ToolResult {
    ok: boolean;
    content: string;
    error?: string;
}

export interface ToolExecutor {
    execute(invocation: ToolInvocation): Promise<ToolResult>;
}

export class ToolRegistry {
    private readonly tools: UnorderedMap<string, ToolDescriptor> = new UnorderedMap<string, ToolDescriptor>();

    register(descriptor: ToolDescriptor): this {
        if (this.tools.has(descriptor.name)) {
            throw new Error(`duplicate tool ${descriptor.name}`);
        }
        this.tools.set(descriptor.name, descriptor);
        return this;
    }

    get(name: string): ToolDescriptor | undefined {
        return this.tools.get(name);
    }

    list(): ToolDescriptor[] {
        return [...this.tools.values()];
    }

    get size(): number {
        return this.tools.size;
    }
}
