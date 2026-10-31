/**
 * Inter-annotator agreement metrics. These are for labeled evaluation, not for
 * model confidence; keep them separate from ECE/Brier.
 */

/**
 * Two label sequences over the same items.
 */
type LabelList = readonly string[];

/**
 * A pairwise agreement statistic over two label sequences.
 */
type AgreementFn = (left: LabelList, right: LabelList) => number;

export const agreementRate: AgreementFn = (left: LabelList, right: LabelList): number => {
    if (left.length !== right.length) {
        throw new Error("label arrays must have equal length");
    }
    if (left.length === 0) {
        return 1;
    }
    let matches: number = 0;
    for (let index: number = 0; index < left.length; index += 1) {
        if (left[index] === right[index]) {
            matches += 1;
        }
    }
    return matches / left.length;
};

/**
 * Cohen's kappa for two raters over the same categorical labels.
 */
export const cohenKappa: AgreementFn = (left: LabelList, right: LabelList): number => {
    if (left.length !== right.length) {
        throw new Error("label arrays must have equal length");
    }
    if (left.length === 0) {
        return 1;
    }
    const observed: number = agreementRate(left, right);
    const categories: string[] = [...new Set([...left, ...right])];
    let expected: number = 0;
    for (let categoryIndex: number = 0; categoryIndex < categories.length; categoryIndex += 1) {
        const category: string = categories[categoryIndex];
        const leftRate: number = left.filter((label) => label === category).length / left.length;
        const rightRate: number = right.filter((label) => label === category).length / right.length;
        expected += leftRate * rightRate;
    }
    if (expected === 1) {
        return observed === 1 ? 1 : 0;
    }
    return (observed - expected) / (1 - expected);
};

/**
 * Fleiss' kappa for n items x m raters.
 */
export const fleissKappa: (matrix: readonly LabelList[]) => number = (matrix: readonly LabelList[]): number => {
    if (matrix.length === 0) {
        return 1;
    }
    const raters: number = matrix[0].length;
    if (raters < 2 || matrix.some((row) => row.length !== raters)) {
        throw new Error("rating matrix requires at least two raters and equal row lengths");
    }
    const categories: string[] = [...new Set(matrix.flat())];
    const total: number = matrix.length * raters;
    const counts: Map<string, number> = new Map<string, number>();
    for (let rowIndex: number = 0; rowIndex < matrix.length; rowIndex += 1) {
        const row: LabelList = matrix[rowIndex];
        for (let labelIndex: number = 0; labelIndex < row.length; labelIndex += 1) {
            const label: string = row[labelIndex];
            counts.set(label, (counts.get(label) ?? 0) + 1);
        }
    }
    const observed: number =
        matrix.reduce((sum: number, row: LabelList): number => {
            let agreements: number = 0;
            for (let categoryIndex: number = 0; categoryIndex < categories.length; categoryIndex += 1) {
                const category: string = categories[categoryIndex];
                const count: number = row.filter((label) => label === category).length;
                agreements += count * (count - 1);
            }
            return sum + agreements / (raters * (raters - 1));
        }, 0) / matrix.length;
    const expected: number = categories.reduce((sum: number, category: string): number => {
        const rate: number = (counts.get(category) ?? 0) / total;
        return sum + rate * rate;
    }, 0);
    if (expected === 1) {
        return observed === 1 ? 1 : 0;
    }
    return (observed - expected) / (1 - expected);
};
