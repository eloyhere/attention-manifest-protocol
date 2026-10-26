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
    /** Upper predicted bound of each block. */
    thresholds: number[];
    /** Observed frequency of each block. */
    values: number[];
}

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

export const brier = (points: readonly CalibrationPoint[]): number => {
    if (points.length === 0) return 0;
    return points.reduce((sum, point) => sum + (point.predicted - (point.actual ? 1 : 0)) ** 2, 0) / points.length;
};

export const ece = (points: readonly CalibrationPoint[], bins = 10): number => {
    if (points.length === 0) return 0;
    const buckets = Array.from({ length: bins }, () => ({ n: 0, confidence: 0, accuracy: 0 }));
    for (const point of points) {
        const index = Math.min(bins - 1, Math.max(0, Math.floor(clamp01(point.predicted) * bins)));
        buckets[index].n += 1;
        buckets[index].confidence += point.predicted;
        buckets[index].accuracy += point.actual ? 1 : 0;
    }
    return buckets.reduce((sum, bucket) => {
        if (bucket.n === 0) return sum;
        return sum + (bucket.n / points.length) * Math.abs(bucket.accuracy / bucket.n - bucket.confidence / bucket.n);
    }, 0);
};

/** Pool-adjacent-violators isotonic regression. */
export const fitIsotonic = (points: readonly CalibrationPoint[]): IsotonicModel => {
    const sorted = [...points].sort((left, right) => left.predicted - right.predicted);
    const blocks: Array<{ sum: number; n: number; max: number }> = [];
    for (const point of sorted) {
        blocks.push({ sum: point.actual ? 1 : 0, n: 1, max: point.predicted });
        while (blocks.length >= 2) {
            const current = blocks[blocks.length - 1];
            const previous = blocks[blocks.length - 2];
            if (previous.sum / previous.n <= current.sum / current.n) break;
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

export const applyIsotonic = (model: IsotonicModel, predicted: number): number => {
    if (model.thresholds.length === 0) return clamp01(predicted);
    const index = model.thresholds.findIndex((threshold) => predicted <= threshold);
    return model.values[index === -1 ? model.values.length - 1 : index];
};

export const crossValidateCalibration = (points: readonly CalibrationPoint[], folds = 5): { ece: number; brier: number; rawEce: number; rawBrier: number } => {
    if (points.length === 0) return { ece: 0, brier: 0, rawEce: 0, rawBrier: 0 };
    const predictions: CalibrationPoint[] = [];
    for (let fold = 0; fold < folds; fold += 1) {
        const train = points.filter((_, index) => index % folds !== fold);
        const test = points.filter((_, index) => index % folds === fold);
        if (train.length === 0 || test.length === 0) continue;
        const model = fitIsotonic(train);
        for (const point of test) predictions.push({ predicted: applyIsotonic(model, point.predicted), actual: point.actual });
    }
    return {
        ece: ece(predictions),
        brier: brier(predictions),
        rawEce: ece(points),
        rawBrier: brier(points),
    };
};
