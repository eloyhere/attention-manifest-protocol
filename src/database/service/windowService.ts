import type { PrimaryKey } from "../entity/entity.ts";
import type { WindowEntity, WindowPageEntity } from "../entity/window.ts";
import { WindowRepository } from "../repository/windowRepository.ts";
import type { WindowPageInput } from "../repository/windowRepository.ts";
import { Service } from "./service.ts";

/**
 * One service per entity: `windows` (plus its `window_pages` children).
 */
export class WindowService extends Service<WindowEntity, PrimaryKey, WindowRepository> {
    constructor(windows: WindowRepository) {
        super(windows, "Window");
    }

    get(tid: number): WindowEntity | undefined {
        return this.findById(tid);
    }

    pages(tid: number): WindowPageEntity[] {
        return this.repository.pages(tid);
    }

    save(tid: number, capacityTokens: number, usedTokens: number, at: string): void {
        this.repository.save(tid, capacityTokens, usedTokens, at);
    }

    replacePages(tid: number, pages: readonly WindowPageInput[], at: string, capacityTokens: number): void {
        this.repository.replacePages(tid, pages, at, capacityTokens);
    }
}
