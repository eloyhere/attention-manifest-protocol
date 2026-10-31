/**
 * Calibration registry.
 *
 * A fitted map is activated only when there are enough points AND its
 * cross-validated ECE beats raw by `minImprovement`. Otherwise the scope stays
 * raw. This prevents the "isotonic made it worse" failure from shipping.
 */
import { applyIsotonic, applyTemperature, fitIsotonic, fitTemperature } from "./calibration.ts";
import type { CalibrationPoint, IsotonicModel, TemperatureModel } from "./calibration.ts";
import { selectCalibration, bootstrapEceDelta } from "./calibrationSelection.ts";
import type { CalibrationMethod, CalibrationSelection } from "./calibrationSelection.ts";

export interface CalibrationModel {
    scope: string;
    method: CalibrationMethod;
    samples: number;
    rawEce: number;
    cvEce: number;
    thresholds: number[];
    values: number[];
    temperature?: number;
    ciLower: number;
    ciUpper: number;
    activatedAt: string;
}

export interface RegisterOptions {
    minSamples?: number;
    minImprovement?: number;
    folds?: number;
    /**
     * Require the bootstrap 95% upper bound to be below zero.
     */
    requireCi?: boolean;
    bootstrapSamples?: number;
    seed?: number;
    at?: string;
}

export interface RegisterResult {
    status: "raw" | "activated";
    selection: CalibrationSelection;
    model?: CalibrationModel;
}

/**
 * Bootstrap confidence interval for the ECE delta.
 */
type BootstrapInterval = {
    mean: number;
    lower: number;
    upper: number;
};

const clamp01: (value: number) => number = (value: number): number => Math.max(0, Math.min(1, value));

export class CalibrationRegistry {
    private readonly models = new Map<string, CalibrationModel>();

    register(scope: string, points: readonly CalibrationPoint[], options: RegisterOptions = {}): RegisterResult {
        const minSamples: number = options.minSamples ?? 30;
        const minImprovement: number = options.minImprovement ?? 0.01;
        const selection: CalibrationSelection = selectCalibration(points, options.folds ?? 5);
        const candidate: boolean = points.length >= minSamples && selection.method !== "raw" && selection.rawEce - selection.ece >= minImprovement;
        const ci: BootstrapInterval = candidate
            ? bootstrapEceDelta(points, selection.method, options.folds ?? 5, options.bootstrapSamples ?? 500, options.seed ?? 42)
            : { mean: 0, lower: 0, upper: 0 };
        const improves: boolean = candidate && (options.requireCi === false || ci.upper < 0);
        if (!improves) {
            this.models.delete(scope);
            return { status: "raw", selection };
        }
        const model: IsotonicModel = fitIsotonic(points);
        const temperature: TemperatureModel = fitTemperature(points);
        const record: CalibrationModel = {
            scope,
            method: selection.method,
            samples: points.length,
            rawEce: selection.rawEce,
            cvEce: selection.ece,
            thresholds: model.thresholds,
            values: model.values,
            ...(selection.method === "temperature" ? { temperature: temperature.temperature } : {}),
            ciLower: ci.lower,
            ciUpper: ci.upper,
            activatedAt: options.at ?? new Date().toISOString(),
        };
        this.models.set(scope, record);
        return { status: "activated", selection, model: record };
    }

    calibrate(scope: string, predicted: number): number {
        const model: CalibrationModel | undefined = this.models.get(scope);
        if (model === (void 0)) {
            return clamp01(predicted);
        }
        if (model.method === "temperature") {
            return applyTemperature({ temperature: model.temperature ?? 1 }, predicted);
        }
        const calibrated: number = applyIsotonic({ thresholds: model.thresholds, values: model.values }, predicted);
        return model.method === "isotonic" ? calibrated : 0.5 * calibrated + 0.5 * clamp01(predicted);
    }

    model(scope: string): CalibrationModel | undefined {
        return this.models.get(scope);
    }

    scopes(): string[] {
        return [...this.models.keys()];
    }
}
