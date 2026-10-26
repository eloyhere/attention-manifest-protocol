/**
 * Inter-annotator agreement metrics. These are for labeled evaluation, not for
 * model confidence; keep them separate from ECE/Brier.
 */
export const agreementRate = (left: readonly string[], right: readonly string[]): number => {
    if (left.length !== right.length) throw new Error("label arrays must have equal length");
    if (left.length === 0) return 1;
    let matches = 0;
    for (let index = 0; index < left.length; index += 1) if (left[index] === right[index]) matches += 1;
    return matches / left.length;
};

/** Cohen's kappa for two raters over the same categorical labels. */
export const cohenKappa = (left: readonly string[], right: readonly string[]): number => {
    if (left.length !== right.length) throw new Error("label arrays must have equal length");
    if (left.length === 0) return 1;
    const observed = agreementRate(left, right);
    const categories = new Set([...left, ...right]);
    let expected = 0;
    for (const category of categories) {
        const leftRate = left.filter((label) => label === category).length / left.length;
        const rightRate = right.filter((label) => label === category).length / right.length;
        expected += leftRate * rightRate;
    }
    if (expected === 1) return observed === 1 ? 1 : 0;
    return (observed - expected) / (1 - expected);
};

/** Fleiss' kappa for n items x m raters. */
export const fleissKappa = (matrix: readonly (readonly string[])[]): number => {
    if (matrix.length === 0) return 1;
    const raters = matrix[0].length;
    if (raters === 0 || matrix.some((row) => row.length !== raters)) throw new Error("ragged rating matrix");
    const categories = new Set(matrix.flat());
    const total = matrix.length * raters;
    const counts = new Map<string, number>();
    for (const row of matrix) for (const label of row) counts.set(label, (counts.get(label) ?? 0) + 1);
    const observed =
        matrix.reduce((sum, row) => {
            let agreements = 0;
            for (const category of categories) {
                const count = row.filter((label) => label === category).length;
                agreements += count * (count - 1);
            }
            return sum + agreements / (raters * (raters - 1));
        }, 0) / matrix.length;
    const expected = [...categories].reduce((sum, category) => {
        const rate = (counts.get(category) ?? 0) / total;
        return sum + rate * rate;
    }, 0);
    if (expected === 1) return observed === 1 ? 1 : 0;
    return (observed - expected) / (1 - expected);
};
