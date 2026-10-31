/**
 * Durable store for the governance objects themselves.
 *
 * The audit chain records that an act happened; this store keeps the object a
 * later process needs to resume: the latest manifest per id, credentials and
 * board receipts. It is an append-only JSONL event log, so replaying the file
 * reconstructs the latest state without trusting the writer's memory.
 */
import { AppendLog } from "../storage/appendLog.ts";
import type { AppendSink, LogEntry } from "../storage/appendLog.ts";
import type { AttentionManifest } from "./attentionManifest.ts";
import type { BoardReceipt } from "./context.ts";
import type { SwitchCredential } from "./credential.ts";
import { GovernanceError } from "./types.ts";

export type StoredGovernanceKind = "manifest" | "credential" | "receipt";

interface StoredGovernanceRecord {
    type: StoredGovernanceKind;
    value: unknown;
}

export interface GovernanceStoreSnapshot {
    manifests: AttentionManifest[];
    credentials: SwitchCredential[];
    receipts: BoardReceipt[];
    count: number;
}

const isRecord: (value: unknown) => value is Record<string, unknown> = (value: unknown): value is Record<string, unknown> =>
    typeof(value) === "object" && value !== null && !Array.isArray(value);

const isStoredRecord: (value: unknown) => value is StoredGovernanceRecord = (value: unknown): value is StoredGovernanceRecord =>
    isRecord(value) && (value.type === "manifest" || value.type === "credential" || value.type === "receipt") && isRecord(value.value);

export class GovernanceStore {
    private readonly log: AppendLog;
    private readonly manifests = new Map<string, AttentionManifest>();
    private readonly credentials = new Map<string, SwitchCredential>();
    private readonly receipts = new Map<string, BoardReceipt>();

    private constructor(log: AppendLog) {
        this.log = log;
    }

    static async open(sink: AppendSink): Promise<GovernanceStore> {
        const log: AppendLog = await AppendLog.open(sink);
        const store: GovernanceStore = new GovernanceStore(log);
        store.replay();
        return store;
    }

    private replay(): void {
        const entries: readonly LogEntry[] = this.log.entries();
        for (let index: number = 0; index < entries.length; index += 1) {
            const payload: unknown = entries[index].payload;
            if (!isStoredRecord(payload)) {
                throw new GovernanceError("registry-invalid", `entry ${index} is not a governance record`);
            }
            this.apply(payload);
        }
    }

    private apply(record: StoredGovernanceRecord): void {
        if (record.type === "manifest") {
            const value: AttentionManifest = record.value as AttentionManifest;
            const existing: AttentionManifest | undefined = this.manifests.get(value.id);
            if (existing === (void 0) || existing.version <= value.version) {
                this.manifests.set(value.id, value);
            }
            return;
        }
        if (record.type === "credential") {
            const value: SwitchCredential = record.value as SwitchCredential;
            this.credentials.set(value.id, value);
            return;
        }
        const value: BoardReceipt = record.value as BoardReceipt;
        this.receipts.set(value.id, value);
    }

    async saveManifest(manifest: AttentionManifest): Promise<void> {
        await this.log.append("event", { type: "manifest", value: manifest } satisfies StoredGovernanceRecord);
        this.apply({ type: "manifest", value: manifest });
    }

    async saveCredential(credential: SwitchCredential): Promise<void> {
        await this.log.append("event", { type: "credential", value: credential } satisfies StoredGovernanceRecord);
        this.apply({ type: "credential", value: credential });
    }

    async saveReceipt(receipt: BoardReceipt): Promise<void> {
        await this.log.append("event", { type: "receipt", value: receipt } satisfies StoredGovernanceRecord);
        this.apply({ type: "receipt", value: receipt });
    }

    getManifest(id: string): AttentionManifest | undefined {
        return this.manifests.get(id);
    }

    getCredential(id: string): SwitchCredential | undefined {
        return this.credentials.get(id);
    }

    getReceipt(id: string): BoardReceipt | undefined {
        return this.receipts.get(id);
    }

    snapshot(): GovernanceStoreSnapshot {
        return {
            manifests: [...this.manifests.values()].map((manifest) => JSON.parse(JSON.stringify(manifest)) as AttentionManifest),
            credentials: [...this.credentials.values()].map((credential) => JSON.parse(JSON.stringify(credential)) as SwitchCredential),
            receipts: [...this.receipts.values()].map((receipt) => JSON.parse(JSON.stringify(receipt)) as BoardReceipt),
            count: this.log.count,
        };
    }

    verify(): { ok: boolean; reasons: string[]; } {
        return this.log.verify();
    }

    get count(): number {
        return this.log.count;
    }
}
