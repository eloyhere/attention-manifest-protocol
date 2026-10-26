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

export interface CvPrediction {
    predicted: number;
    actual: boolean;
}

export const crossValidatedPredictions = (points: readonly CalibrationPoint[], method: CalibrationMethod, folds: number): CvPrediction[] => {
    const predictions: CvPrediction[] = [];
    for (let fold = 0; fold < folds; fold += 1) {
        const train = points.filter((_, index) => index % folds !== fold);
        const test = points.filter((_, index) => index % folds === fold);
        if (train.length === 0 || test.length === 0) continue;
        const isotonic = fitIsotonic(train);
        const temperature = fitTemperature(train);
        for (const point of test) predictions.push({ predicted: predict(method, isotonic, temperature, point.predicted), actual: point.actual });
    }
    return predictions;
};

const crossValidate = (points: readonly CalibrationPoint[], method: CalibrationMethod, folds: number): { ece: number; brier: number } => {
    const predictions = crossValidatedPredictions(points, method, folds);
    return { ece: ece(predictions), brier: brier(predictions) };
};

const mulberry32 = (seed: number): (() => number) => {
    let state = seed >>> 0;
    return () => {
        state += 0x6d2b79f5;
        let value = Math.imul(state ^ (state >>> 15), 1 | state);
        value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
};

/** Paired bootstrap of ECE(calibrated) - ECE(raw); negative means improvement. */
export const bootstrapEceDelta = (
    points: readonly CalibrationPoint[],
    method: CalibrationMethod,
    folds = 5,
    samples = 500,
    seed = 42,
): { mean: number; lower: number; upper: number } => {
    const raw = crossValidatedPredictions(points, "raw", folds);
    const calibrated = crossValidatedPredictions(points, method, folds);
    if (raw.length === 0 || raw.length !== calibrated.length) return { mean: 0, lower: 0, upper: 0 };
    const random = mulberry32(seed);
    const deltas: number[] = [];
    for (let sample = 0; sample < samples; sample += 1) {
        const left: CvPrediction[] = [];
        const right: CvPrediction[] = [];
        for (let index = 0; index < raw.length; index += 1) {
            const pick = Math.floor(random() * raw.length);
            left.push(raw[pick]);
            right.push(calibrated[pick]);
        }
        deltas.push(ece(right) - ece(left));
    }
    deltas.sort((a, b) => a - b);
    const mean = deltas.reduce((sum, value) => sum + value, 0) / deltas.length;
    return {
        mean,
        lower: deltas[Math.floor(deltas.length * 0.025)] ?? mean,
        upper: deltas[Math.floor(deltas.length * 0.975)] ?? mean,
    };
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
