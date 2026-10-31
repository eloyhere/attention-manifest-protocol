/**
 * Global filesystem adapter.
 *
 * The adapter renames the local `amp_tool_filesystem_*` surface to
 * `amp_tool_globalfs_*` and rewrites the response protocol. It owns no tree,
 * cache or write journal of its own: every call goes through the bound
 * `FilesystemSession`, so the session token, roots, quotas and isolation stay
 * exactly as strong as the local surface. A future multi-root router can sit
 * behind the same interface without changing the wire names.
 */
import type { FilesystemSession } from "../file/service.ts";
import type { FilesystemService } from "../file/service.ts";
import type { FilesystemResponse, FilesystemToolDefinition } from "../protocol/filesystem.ts";
import {
    GlobalFilesystemProtocol,
    GlobalFilesystemProtocolVersion,
    globalFilesystemLocalIds,
    globalFilesystemToolDefinitions,
} from "../protocol/globalFilesystem.ts";
import type { GlobalFilesystemResponse } from "../protocol/globalFilesystem.ts";

export class GlobalFilesystemService {
    private readonly base: FilesystemService;

    constructor(base: FilesystemService) {
        this.base = base;
    }

    /**
     * Bind one authenticated session to the global namespace.
     */
    bind(sessionId: string, token: string): GlobalFilesystemSession {
        return new GlobalFilesystemSession(this.base.bind(sessionId, token));
    }

    dispose(sessionId: string): void {
        this.base.dispose(sessionId);
    }
}

export class GlobalFilesystemSession {
    private readonly base: FilesystemSession;

    constructor(base: FilesystemSession) {
        this.base = base;
    }

    get sessionId(): string {
        return this.base.sessionId;
    }

    get descriptor(): FilesystemSession["descriptor"] {
        return this.base.descriptor;
    }

    tools(): FilesystemToolDefinition[] {
        return globalFilesystemToolDefinitions();
    }

    /**
     * Typed delegates keep hook and direct-embedder code identical for the
     * local and global surfaces.
     */
    read: FilesystemSession["read"] = (request): ReturnType<FilesystemSession["read"]> => this.base.read(request);
    write: FilesystemSession["write"] = (request): ReturnType<FilesystemSession["write"]> => this.base.write(request);
    outline: FilesystemSession["outline"] = (request): ReturnType<FilesystemSession["outline"]> => this.base.outline(request);
    imports: FilesystemSession["imports"] = (request): ReturnType<FilesystemSession["imports"]> => this.base.imports(request);
    exports: FilesystemSession["exports"] = (request): ReturnType<FilesystemSession["exports"]> => this.base.exports(request);
    dependency: FilesystemSession["dependency"] = (request): ReturnType<FilesystemSession["dependency"]> => this.base.dependency(request);
    ast: FilesystemSession["ast"] = (request): ReturnType<FilesystemSession["ast"]> => this.base.ast(request);
    revision: FilesystemSession["revision"] = (): string => this.base.revision();

    async call(name: string, raw: unknown): Promise<GlobalFilesystemResponse> {
        const local: string | undefined = globalFilesystemLocalIds.get(name);
        if (local === (void 0)) {
            return {
                protocol: GlobalFilesystemProtocol,
                version: GlobalFilesystemProtocolVersion,
                ok: false,
                revision: `ses.${this.base.descriptor.revision}`,
                session: this.base.sessionId,
                error: { code: "unknown_tool", message: "unknown_tool" },
            };
        }
        const response: FilesystemResponse = await this.base.dispatch(local, raw);
        if ("error" in response) {
            return {
                protocol: GlobalFilesystemProtocol,
                version: GlobalFilesystemProtocolVersion,
                ok: false,
                revision: response.revision,
                session: response.session,
                error: response.error,
            };
        }
        return {
            protocol: GlobalFilesystemProtocol,
            version: GlobalFilesystemProtocolVersion,
            ok: true,
            revision: response.revision,
            session: response.session,
            data: response.data,
        };
    }
}
