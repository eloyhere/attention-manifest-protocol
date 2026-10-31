/**
 * File stores accept only regular files directly inside their canonical directory.
 * Resolve references before checking containment; never follow a file symlink.
 */
import { existsSync, lstatSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

export const storedFile: (dir: string, ref: string) => string | undefined = (dir: string, ref: string): string | undefined => {
    const path: string = resolve(ref);
    if (relative(dir, dirname(path)) !== "" || !existsSync(path) || !lstatSync(path).isFile()) {
        return undefined;
    }
    return path;
};
