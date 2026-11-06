import type { WorkspaceFile } from "../file/core.ts";
import { WorkspaceFile as File } from "../file/core.ts";
import type { FileStoragePort, MountOptions, OutlineProvider } from "../file/types.ts";
import type { WorkspaceOptions } from "./types.ts";
import { WorkspaceError } from "./types.ts";

/** Workspace is the scoped host adapter and file assembler; it performs no filesystem access. */
export class Workspace {
    readonly tenantId: string;
    readonly rootId: string;
    readonly storage: FileStoragePort;
    private readonly outlineProvider?: OutlineProvider;

    constructor(options: WorkspaceOptions) {
        if (!options.tenantId || !options.rootId) throw new WorkspaceError("invalid_scope", "tenantId and rootId are required");
        this.tenantId = options.tenantId;
        this.rootId = options.rootId;
        this.storage = options.storage;
        this.outlineProvider = options.outline;
    }

    file(path: string, options: MountOptions = {}): WorkspaceFile {
        const outline = options.outline ?? this.outlineProvider;
        return new File(this, path, outline === undefined ? options : { ...options, outline });
    }

    mount(path: string, options?: MountOptions): WorkspaceFile {
        const file = this.file(path, options);
        file.mount();
        file.activate();
        return file;
    }
}

export { WorkspaceError } from "./types.ts";
export type { WorkspaceOptions } from "./types.ts";
