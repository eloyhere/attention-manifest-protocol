/**
 * Annotation import and adjudication.
 *
 * This is deliberately file-oriented: human labels may come from a spreadsheet,
 * a CSV export or a small JSONL file. The audit reports coverage, duplicates,
 * disagreements and pairwise Cohen's kappa before any label is trusted.
 */
import { cohenKappa } from "./agreement.ts";

export interface Annotation {
    caseId: string;
    annotator: string;
    label: string;
    note?: string;
}

export interface LabelCandidate {
    caseId: string;
    predicted: number;
    uncertainty?: number;
}

const splitCsvRecords = (text: string): string[][] => {
    const records: string[][] = [];
    let record: string[] = [];
    let cell = "";
    let quoted = false;
    for (let index = 0; index < text.length; index += 1) {
        const char = text[index];
        if (char === '"') {
            if (quoted && text[index + 1] === '"') {
                cell += '"';
                index += 1;
            } else {
                quoted = !quoted;
            }
        } else if (char === "," && !quoted) {
            record.push(cell);
            cell = "";
        } else if ((char === "\n" || char === "\r") && !quoted) {
            if (char === "\r" && text[index + 1] === "\n") {
                index += 1;
            }
            record.push(cell);
            if (record.some((entry) => entry.trim().length > 0)) {
                records.push(record);
            }
            record = [];
            cell = "";
        } else {
            cell += char;
        }
    }
    if (cell.length > 0 || record.length > 0) {
        record.push(cell);
        if (record.some((entry) => entry.trim().length > 0)) {
            records.push(record);
        }
    }
    return records;
};

/**
 * CSV header: caseId,annotator,label[,note]. Handles quoted newlines.
 */
export const importAnnotationsCsv = (text: string): Annotation[] => {
    const records = splitCsvRecords(text.replace(/^\uFEFF/, ""));
    if (records.length === 0) {
        return [];
    }
    const header = records[0].map((cell) => cell.trim());
    const indexOf = (name: string): number => header.indexOf(name);
    if (indexOf("caseId") < 0 || indexOf("annotator") < 0 || indexOf("label") < 0) {
        throw new Error("CSV header requires caseId, annotator, label");
    }
    return records.slice(1).map((cells, row) => {
        const caseId = cells[indexOf("caseId")]?.trim();
        const annotator = cells[indexOf("annotator")]?.trim();
        const label = cells[indexOf("label")]?.trim();
        if (caseId === (void 0) || annotator === (void 0) || label === (void 0)) {
            throw new Error(`CSV row ${row + 2} is incomplete`);
        }
        const note = indexOf("note") >= 0 ? cells[indexOf("note")]?.trim() : undefined;
        return { caseId, annotator, label, ...(note === (void 0) || note.length === 0 ? {} : { note }) };
    });
};

/**
 * Active learning: prefer predicted probability near 0.5 and high uncertainty.
 */
export const selectLabelCandidates = (candidates: readonly LabelCandidate[], budget: number): LabelCandidate[] => {
    return [...candidates]
        .sort((left, right) => {
            const leftScore = (1 - Math.abs(left.predicted - 0.5) * 2) * 0.6 + (left.uncertainty ?? 0) * 0.4;
            const rightScore = (1 - Math.abs(right.predicted - 0.5) * 2) * 0.6 + (right.uncertainty ?? 0) * 0.4;
            return rightScore - leftScore;
        })
        .slice(0, Math.max(0, budget));
};

/**
 * Fill only unresolved ties; resolved cases keep their majority label.
 */
export const resolveUnresolved = (audit: LabelAudit, resolutions: Record<string, string>): Record<string, string | null> => {
    const result = { ...audit.adjudicated };
    for (const [caseId, label] of Object.entries(resolutions)) {
        if (result[caseId] !== null) {
            continue;
        }
        result[caseId] = label;
    }
    return result;
};

/**
 * Reject an annotation batch before it is used for calibration.
 */
export const requireLabelCoverage = (audit: LabelAudit, options: { minCoverage?: number; maxDuplicates?: number } = {}): void => {
    const minCoverage = options.minCoverage ?? 0.9;
    const maxDuplicates = options.maxDuplicates ?? 0;
    if (audit.coverage < minCoverage) {
        throw new Error(`label coverage ${audit.coverage.toFixed(3)} < ${minCoverage}`);
    }
    if (audit.duplicates.length > maxDuplicates) {
        throw new Error(`duplicate annotations: ${audit.duplicates.length}`);
    }
};

export interface LabelAudit {
    cases: number;
    annotations: number;
    covered: number;
    coverage: number;
    missing: string[];
    duplicates: Array<{ caseId: string; annotator: string; count: number }>;
    disagreements: Array<{ caseId: string; labels: Record<string, number> }>;
    annotators: string[];
    pairwiseKappa: Array<{ left: string; right: string; kappa: number; common: number }>;
    adjudicated: Record<string, string | null>;
}

export const importAnnotations = (input: unknown): Annotation[] => {
    const rows = Array.isArray(input)
        ? input
        : `${input}`
              .split(/\r?\n/)
              .filter((line) => line.trim().length > 0)
              .map((line) => JSON.parse(line));
    return rows.map((row: unknown, index: number) => {
        const value = row as Partial<Annotation>;
        if (typeof(value.caseId) !== "string" || typeof(value.annotator) !== "string" || typeof(value.label) !== "string") {
            throw new Error(`annotation ${index} requires caseId, annotator and label`);
        }
        return { caseId: value.caseId, annotator: value.annotator, label: value.label, ...(typeof(value.note) === "string" ? { note: value.note } : {}) };
    });
};

const pairKappa = (caseIds: readonly string[], annotations: readonly Annotation[], left: string, right: string): { kappa: number; common: number } => {
    const common: Array<{ caseId: string; left?: string; right?: string }> = [];
    for (const caseId of caseIds) {
        const leftLabel = annotations.find((annotation) => annotation.caseId === caseId && annotation.annotator === left)?.label;
        const rightLabel = annotations.find((annotation) => annotation.caseId === caseId && annotation.annotator === right)?.label;
        if (leftLabel !== (void 0) && rightLabel !== (void 0)) {
            common.push({ caseId, left: leftLabel, right: rightLabel });
        }
    }
    if (common.length === 0) {
        return { kappa: 1, common: 0 };
    }
    return {
        kappa: cohenKappa(
            common.map((entry) => entry.left as string),
            common.map((entry) => entry.right as string),
        ),
        common: common.length,
    };
};

export const auditLabels = (caseIds: readonly string[], annotations: readonly Annotation[]): LabelAudit => {
    const ids = new Set(caseIds);
    const annotators = [...new Set(annotations.map((annotation) => annotation.annotator))].sort();
    const counts = new Map<string, number>();
    for (const annotation of annotations) {
        counts.set(`${annotation.caseId}\u0000${annotation.annotator}`, (counts.get(`${annotation.caseId}\u0000${annotation.annotator}`) ?? 0) + 1);
    }
    const duplicates = [...counts.entries()]
        .filter(([, count]) => count > 1)
        .map(([key, count]) => {
            const [caseId, annotator] = key.split("\u0000");
            return { caseId, annotator, count };
        });

    const missing = caseIds.filter((caseId) => !annotations.some((annotation) => annotation.caseId === caseId));
    const disagreements = caseIds
        .map((caseId) => {
            const labels: Record<string, number> = {};
            for (const annotation of annotations.filter((entry) => entry.caseId === caseId)) {
                labels[annotation.label] = (labels[annotation.label] ?? 0) + 1;
            }
            return { caseId, labels };
        })
        .filter((entry) => Object.keys(entry.labels).length > 1);

    const adjudicated: Record<string, string | null> = {};
    for (const caseId of caseIds) {
        const countsForCase: Record<string, number> = {};
        for (const annotation of annotations.filter((entry) => entry.caseId === caseId)) {
            countsForCase[annotation.label] = (countsForCase[annotation.label] ?? 0) + 1;
        }
        const ranked = Object.entries(countsForCase).sort((left, right) => right[1] - left[1]);
        if (ranked.length === 0) {
            adjudicated[caseId] = null;
        } else if (ranked.length > 1 && ranked[0][1] === ranked[1][1]) {
            adjudicated[caseId] = null;
        } else {
            adjudicated[caseId] = ranked[0][0];
        }
    }

    const pairwiseKappa: LabelAudit["pairwiseKappa"] = [];
    for (let left = 0; left < annotators.length; left += 1) {
        for (let right = left + 1; right < annotators.length; right += 1) {
            const result = pairKappa(caseIds, annotations, annotators[left], annotators[right]);
            pairwiseKappa.push({ left: annotators[left], right: annotators[right], ...result });
        }
    }

    const covered = caseIds.filter((caseId) => annotations.some((annotation) => annotation.caseId === caseId)).length;
    return {
        cases: caseIds.length,
        annotations: annotations.filter((annotation) => ids.has(annotation.caseId)).length,
        covered,
        coverage: caseIds.length === 0 ? 1 : covered / caseIds.length,
        missing,
        duplicates,
        disagreements,
        annotators,
        pairwiseKappa,
        adjudicated,
    };
};
