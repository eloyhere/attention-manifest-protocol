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

/**
 * Maps a raw probability through one calibration method.
 */
type Predictor = (method: CalibrationMethod, isotonic: IsotonicModel, temperature: TemperatureModel, value: number) => number;

const clamp01: (value: number) => number = (value: number): number => Math.max(0, Math.min(1, value));

const predict: Predictor = (method: CalibrationMethod, isotonic: IsotonicModel, temperature: TemperatureModel, value: number): number => {
    if (method === "raw") {
        return clamp01(value);
    }
    if (method === "temperature") {
        return applyTemperature(temperature, value);
    }
    const calibrated: number = applyIsotonic(isotonic, value);
    return method === "isotonic" ? calibrated : 0.5 * calibrated + 0.5 * value;
};

export interface CvPrediction {
    predicted: number;
    actual: boolean;
}

/**
 * Emits one out-of-fold prediction per calibration point.
 */
type CrossValidatedPredictor = (points: readonly CalibrationPoint[], method: CalibrationMethod, folds: number) => CvPrediction[];

export const crossValidatedPredictions: CrossValidatedPredictor = (points: readonly CalibrationPoint[], method: CalibrationMethod, folds: number) => {
    const predictions: CvPrediction[] = [];
    for (let fold: number = 0; fold < folds; fold += 1) {
        const train: CalibrationPoint[] = points.filter((_, index) => index % folds !== fold);
        const test: CalibrationPoint[] = points.filter((_, index) => index % folds === fold);
        if (train.length === 0 || test.length === 0) {
            continue;
        }
        const isotonic: IsotonicModel = fitIsotonic(train);
        const temperature: TemperatureModel = fitTemperature(train);
        for (let index: number = 0; index < test.length; index += 1) {
            const point: CalibrationPoint = test[index];
            predictions.push({ predicted: predict(method, isotonic, temperature, point.predicted), actual: point.actual });
        }
    }
    return predictions;
};

/**
 * Cross-validated ECE and Brier score for one method.
 */
type CalibrationScore = {
    ece: number;
    brier: number;
};

/**
 * Scores one calibration method by cross-validated ECE and Brier.
 */
type CrossValidator = (points: readonly CalibrationPoint[], method: CalibrationMethod, folds: number) => CalibrationScore;

const crossValidate: CrossValidator = (points: readonly CalibrationPoint[], method: CalibrationMethod, folds: number): CalibrationScore => {
    const predictions: CvPrediction[] = crossValidatedPredictions(points, method, folds);
    return { ece: ece(predictions), brier: brier(predictions) };
};

const mulberry32: (seed: number) => () => number = (seed: number): (() => number) => {
    let state: number = seed >>> 0;
    return () => {
        state += 0x6d2b79f5;
        let value: number = Math.imul(state ^ (state >>> 15), 1 | state);
        value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
};

/**
 * Percentile interval for the paired ECE delta.
 */
type BootstrapInterval = {
    mean: number;
    lower: number;
    upper: number;
};

/**
 * Bootstrap signature for the ECE delta estimate.
 */
type BootstrapDelta = (points: readonly CalibrationPoint[], method: CalibrationMethod, folds?: number, samples?: number, seed?: number) => BootstrapInterval;

/**
 * Paired bootstrap of ECE(calibrated) - ECE(raw); negative means improvement.
 */
export const bootstrapEceDelta: BootstrapDelta = (points: readonly CalibrationPoint[], method: CalibrationMethod, folds = 5, samples = 500, seed = 42) => {
    const raw: CvPrediction[] = crossValidatedPredictions(points, "raw", folds);
    const calibrated: CvPrediction[] = crossValidatedPredictions(points, method, folds);
    if (raw.length === 0 || raw.length !== calibrated.length) {
        return { mean: 0, lower: 0, upper: 0 };
    }
    const random: () => number = mulberry32(seed);
    const deltas: number[] = [];
    for (let sample: number = 0; sample < samples; sample += 1) {
        const left: CvPrediction[] = [];
        const right: CvPrediction[] = [];
        for (let index: number = 0; index < raw.length; index += 1) {
            const pick: number = Math.floor(random() * raw.length);
            left.push(raw[pick]);
            right.push(calibrated[pick]);
        }
        deltas.push(ece(right) - ece(left));
    }
    deltas.sort((a, b) => a - b);
    const mean: number = deltas.reduce((sum, value) => sum + value, 0) / deltas.length;
    return {
        mean,
        lower: deltas[Math.floor(deltas.length * 0.025)] ?? mean,
        upper: deltas[Math.floor(deltas.length * 0.975)] ?? mean,
    };
};

/**
 * Picks the calibration method with the lowest cross-validated ECE.
 */
type CalibrationSelector = (points: readonly CalibrationPoint[], folds?: number) => CalibrationSelection;

export const selectCalibration: CalibrationSelector = (points: readonly CalibrationPoint[], folds: number = 5): CalibrationSelection => {
    const rawEce: number = ece(points);
    const rawBrier: number = brier(points);
    const candidates: CalibrationSelection[] = [{ method: "raw", ece: rawEce, brier: rawBrier, rawEce, rawBrier }];
    const methods: readonly CalibrationMethod[] = ["isotonic", "shrunk", "temperature"];
    for (let index: number = 0; index < methods.length; index += 1) {
        const method: CalibrationMethod = methods[index];
        const score: CalibrationScore = crossValidate(points, method, folds);
        candidates.push({ method, ece: score.ece, brier: score.brier, rawEce, rawBrier });
    }
    candidates.sort((left, right) => left.ece - right.ece || (left.method === "raw" ? -1 : 1));
    return candidates[0];
};
