/**
 * Calibration model selection. Fits raw / isotonic / shrunk isotonic /
 * temperature on each cross-validation fold and picks the lowest ECE; ties
 * prefer raw.
 */
import { applyIsotonic, applyTemperature, brier, ece, fitIsotonic, fitTemperature } from "./calibration.ts";
import type { CalibrationPoint, IsotonicModel, TemperatureModel } from "./calibration.ts";

export type CalibrationMethod = "raw" | "isotonic" | "shrunk" | "temperature";

export interface CalibrationSelection {
    method: CalibrationMethod;
    ece: number;
    brier: number;
    rawEce: number;
    rawBrier: number;
}

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

const predict = (method: CalibrationMethod, isotonic: IsotonicModel, temperature: TemperatureModel, value: number): number => {
    if (method === "raw") return clamp01(value);
    if (method === "temperature") return applyTemperature(temperature, value);
    const calibrated = applyIsotonic(isotonic, value);
    return method === "isotonic" ? calibrated : 0.5 * calibrated + 0.5 * value;
};

const crossValidate = (points: readonly CalibrationPoint[], method: CalibrationMethod, folds: number): { ece: number; brier: number } => {
    const predictions: CalibrationPoint[] = [];
    for (let fold = 0; fold < folds; fold += 1) {
        const train = points.filter((_, index) => index % folds !== fold);
        const test = points.filter((_, index) => index % folds === fold);
        if (train.length === 0 || test.length === 0) continue;
        const isotonic = fitIsotonic(train);
        const temperature = fitTemperature(train);
        for (const point of test) predictions.push({ predicted: predict(method, isotonic, temperature, point.predicted), actual: point.actual });
    }
    return { ece: ece(predictions), brier: brier(predictions) };
};

export const selectCalibration = (points: readonly CalibrationPoint[], folds = 5): CalibrationSelection => {
    const rawEce = ece(points);
    const rawBrier = brier(points);
    const candidates: CalibrationSelection[] = [{ method: "raw", ece: rawEce, brier: rawBrier, rawEce, rawBrier }];
    for (const method of ["isotonic", "shrunk", "temperature"] as const) {
        const score = crossValidate(points, method, folds);
        candidates.push({ method, ece: score.ece, brier: score.brier, rawEce, rawBrier });
    }
    candidates.sort((left, right) => left.ece - right.ece || (left.method === "raw" ? -1 : 1));
    return candidates[0];
};
