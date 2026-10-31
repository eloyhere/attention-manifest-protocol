import { rm } from "node:fs/promises";
import { resolve } from "node:path";

const LegacyFiles: readonly string[] = [
    "eslint.config.js",
    "prettier.config.mjs",
    "tools/eslint-rules/index.js",
    "tools/eslint-rules/rules/no-function-keyword.js",
    "tools/eslint-rules/rules/no-multiline-parameters.js",
    "tools/eslint-rules/rules/no-undefined-comparison.js",
    "tools/eslint-rules/rules/prefer-template-for-string-conversion.js",
    "tools/eslint-rules/rules/require-typeof-parentheses.js",
    "tools/eslint-rules/rules/require-variable-type.js",
    "tools/eslint-rules/rules/variable-naming.js",
    "tools/prettier-plugin/index.mjs",
    ".delete-probe",
];

const ProjectRoot: string = resolve(import.meta.dirname, "..");

await Promise.all(
    LegacyFiles.map((file: string) => {
        const filePath: string = resolve(ProjectRoot, file);

        return rm(filePath, { force: true });
    }),
);

console.log("Removed legacy JavaScript style configuration files.");
