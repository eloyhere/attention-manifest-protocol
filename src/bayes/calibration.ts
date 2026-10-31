/**
 * Post-hoc calibration utilities.
 *
 * The model's posterior is not trusted as-is; we measure ECE/Brier and fit a
 * monotone isotonic map only for evaluation. Cross-validation is mandatory on
 * small samples so the "improvement" is not just in-sample overfit.
 */
export interface CalibrationPoint {
    predicted: number;
    actual: boolean;
}

export interface IsotonicModel {
    /**
     * Upper predicted bound of each block.
     */
    thresholds: number[];
    /**
     * Observed frequency of each block.
     */
    values: number[];
}

/**
 * Calibration statistics for one set of predictions.
 */
type CalibrationReport = {
    ece: number;
    brier: number;
    rawEce: number;
    rawBrier: number;
};

/**
 * One isotonic block: summed outcomes, sample count and upper bound.
 */
type Block = {
    sum: number;
    n: number;
    max: number;
};

/**
 * One reliability bin.
 */
type Bucket = {
    n: number;
    confidence: number;
    accuracy: number;
};

/**
 * Expected calibration error over optionally binned predictions.
 */
type EceScore = (points: readonly CalibrationPoint[], bins?: number) => number;

/**
 * Fit an isotonic map to the given points.
 */
type FitIsotonic = (points: readonly CalibrationPoint[]) => IsotonicModel;

/**
 * Fit a temperature scalar to the given points.
 */
type FitTemperature = (points: readonly CalibrationPoint[], grid?: readonly number[]) => TemperatureModel;

/**
 * Apply a temperature scalar to one prediction.
 */
type ApplyTemperature = (model: TemperatureModel, predicted: number) => number;

/**
 * Cross-validated calibration report.
 */
type CrossValidate = (points: readonly CalibrationPoint[], folds?: number) => CalibrationReport;

const DefaultGrid: readonly number[] = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, 4, 5];

const clamp01: (value: number) => number = (value: number): number => Math.max(0, Math.min(1, value));

export const brier: (points: readonly CalibrationPoint[]) => number = (points: readonly CalibrationPoint[]): number => {
    if (points.length === 0) {
        return 0;
    }
    return points.reduce((sum, point) => sum + (point.predicted - (point.actual ? 1 : 0)) ** 2, 0) / points.length;
};

export const ece: EceScore = (points: readonly CalibrationPoint[], bins: number = 10): number => {
    if (points.length === 0) {
        return 0;
    }
    const buckets: Bucket[] = Array.from({ length: bins }, () => ({ n: 0, confidence: 0, accuracy: 0 }));
    for (let i: number = 0; i < points.length; i += 1) {
        const point: CalibrationPoint = points[i];
        const index: number = Math.min(bins - 1, Math.max(0, Math.floor(clamp01(point.predicted) * bins)));
        buckets[index].n += 1;
        buckets[index].confidence += point.predicted;
        buckets[index].accuracy += point.actual ? 1 : 0;
    }
    return buckets.reduce((sum, bucket) => {
        if (bucket.n === 0) {
            return sum;
        }
        return sum + (bucket.n / points.length) * Math.abs(bucket.accuracy / bucket.n - bucket.confidence / bucket.n);
    }, 0);
};

/**
 * Pool-adjacent-violators isotonic regression.
 */
export const fitIsotonic: FitIsotonic = (points: readonly CalibrationPoint[]): IsotonicModel => {
    const sorted: CalibrationPoint[] = [...points].sort((left, right) => left.predicted - right.predicted);
    const blocks: Block[] = [];
    for (let i: number = 0; i < sorted.length; i += 1) {
        const point: CalibrationPoint = sorted[i];
        blocks.push({ sum: point.actual ? 1 : 0, n: 1, max: point.predicted });
        while (blocks.length >= 2) {
            const current: Block = blocks[blocks.length - 1];
            const previous: Block = blocks[blocks.length - 2];
            if (previous.sum / previous.n <= current.sum / current.n) {
                break;
            }
            blocks.splice(blocks.length - 2, 2, {
                sum: previous.sum + current.sum,
                n: previous.n + current.n,
                max: current.max,
            });
        }
    }
    return {
        thresholds: blocks.map((block) => block.max),
        values: blocks.map((block) => block.sum / block.n),
    };
};

export const applyIsotonic: (model: IsotonicModel, predicted: number) => number = (model: IsotonicModel, predicted: number): number => {
    if (model.thresholds.length === 0) {
        return clamp01(predicted);
    }
    const index: number = model.thresholds.findIndex((threshold) => predicted <= threshold);
    return model.values[index === -1 ? model.values.length - 1 : index];
};

export interface TemperatureModel {
    temperature: number;
}

const logit: (value: number) => number = (value: number): number => {
    const bounded: number = Math.max(1e-6, Math.min(1 - 1e-6, value));
    return Math.log(bounded / (1 - bounded));
};

const sigmoid: (value: number) => number = (value: number): number => 1 / (1 + Math.exp(-value));

/**
 * Grid-fit temperature by NLL; T<1 sharpens, T>1 softens.
 */
export const fitTemperature: FitTemperature = (points: readonly CalibrationPoint[], grid: readonly number[] = DefaultGrid): TemperatureModel => {
    if (points.length === 0) {
        return { temperature: 1 };
    }
    let best: number = 1;
    let bestLoss: number = Number.POSITIVE_INFINITY;
    for (let i: number = 0; i < grid.length; i += 1) {
        const temperature: number = grid[i];
        const loss: number = points.reduce((sum, point) => {
            const calibrated: number = sigmoid(logit(point.predicted) / temperature);
            const target: number = point.actual ? 1 : 0;
            return sum - (target * Math.log(Math.max(1e-9, calibrated)) + (1 - target) * Math.log(Math.max(1e-9, 1 - calibrated)));
        }, 0);
        if (loss < bestLoss) {
            bestLoss = loss;
            best = temperature;
        }
    }
    return { temperature: best };
};

export const applyTemperature: ApplyTemperature = (model: TemperatureModel, predicted: number): number => sigmoid(logit(predicted) / model.temperature);

export const crossValidateCalibration: CrossValidate = (points: readonly CalibrationPoint[], folds: number = 5): CalibrationReport => {
    if (points.length === 0) {
        return { ece: 0, brier: 0, rawEce: 0, rawBrier: 0 };
    }
    const predictions: CalibrationPoint[] = [];
    for (let fold: number = 0; fold < folds; fold += 1) {
        const train: CalibrationPoint[] = points.filter((_point, index) => index % folds !== fold);
        const test: CalibrationPoint[] = points.filter((_point, index) => index % folds === fold);
        if (train.length === 0 || test.length === 0) {
            continue;
        }
        const model: IsotonicModel = fitIsotonic(train);
        for (let i: number = 0; i < test.length; i += 1) {
            const point: CalibrationPoint = test[i];
            predictions.push({ predicted: applyIsotonic(model, point.predicted), actual: point.actual });
        }
    }
    return {
        ece: ece(predictions),
        brier: brier(predictions),
        rawEce: ece(points),
        rawBrier: brier(points),
    };
};
