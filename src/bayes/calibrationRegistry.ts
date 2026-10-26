/**
 * Calibration registry.
 *
 * A fitted map is activated only when there are enough points AND its
 * cross-validated ECE beats raw by `minImprovement`. Otherwise the scope stays
 * raw. This prevents the "isotonic made it worse" failure from shipping.
 */
import { applyIsotonic, applyTemperature, fitIsotonic, fitTemperature } from "./calibration.ts";
import type { CalibrationPoint, IsotonicModel, TemperatureModel } from "./calibration.ts";
import { selectCalibration } from "./calibrationSelection.ts";
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
    activatedAt: string;
}

export interface RegisterOptions {
    minSamples?: number;
    minImprovement?: number;
    folds?: number;
    at?: string;
}

export interface RegisterResult {
    status: "raw" | "activated";
    selection: CalibrationSelection;
    model?: CalibrationModel;
}

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

export class CalibrationRegistry {
    private readonly models = new Map<string, CalibrationModel>();

    register(scope: string, points: readonly CalibrationPoint[], options: RegisterOptions = {}): RegisterResult {
        const minSamples = options.minSamples ?? 30;
        const minImprovement = options.minImprovement ?? 0.01;
        const selection = selectCalibration(points, options.folds ?? 5);
        const improves = points.length >= minSamples && selection.method !== "raw" && selection.rawEce - selection.ece >= minImprovement;
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
            activatedAt: options.at ?? new Date().toISOString(),
        };
        this.models.set(scope, record);
        return { status: "activated", selection, model: record };
    }

    calibrate(scope: string, predicted: number): number {
        const model = this.models.get(scope);
        if (model === undefined) return clamp01(predicted);
        if (model.method === "temperature") return applyTemperature({ temperature: model.temperature ?? 1 }, predicted);
        const calibrated = applyIsotonic({ thresholds: model.thresholds, values: model.values }, predicted);
        return model.method === "isotonic" ? calibrated : 0.5 * calibrated + 0.5 * clamp01(predicted);
    }

    model(scope: string): CalibrationModel | undefined {
        return this.models.get(scope);
    }

    scopes(): string[] {
        return [...this.models.keys()];
    }
}
