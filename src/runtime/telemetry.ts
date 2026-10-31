/**
 * Real Node telemetry for attention/rest. It is process-level, not a model of
 * human fatigue: the fields only inform scheduling.
 */
import os from "node:os";
import { monitorEventLoopDelay } from "node:perf_hooks";

export interface TelemetrySample {
    /**
     * 0–1, normalized by CPU count.
     */
    systemLoad?: number;
    eventLoopLagMs?: number;
    memoryMb?: number;
    queueDepth?: number;
    errorRate?: number;
}

export interface TelemetrySource {
    sample(): TelemetrySample;
}

export class StaticTelemetry implements TelemetrySource {
    private readonly value: TelemetrySample;

    constructor(value: TelemetrySample) {
        this.value = value;
    }

    sample(): TelemetrySample {
        return { ...this.value };
    }
}

export class NodeTelemetry implements TelemetrySource {
    private readonly histogram = monitorEventLoopDelay({ resolution: 20 });

    constructor() {
        this.histogram.enable();
    }

    sample(): TelemetrySample {
        const cpus = Math.max(1, os.cpus().length);
        const meanLag = this.histogram.mean;
        return {
            systemLoad: Math.min(1, os.loadavg()[0] / cpus),
            eventLoopLagMs: Number.isFinite(meanLag) ? meanLag / 1_000_000 : 0,
            memoryMb: process.memoryUsage().rss / (1024 * 1024),
        };
    }

    close(): void {
        this.histogram.disable();
    }
}
