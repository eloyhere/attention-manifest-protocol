import { rm } from "node:fs/promises";
import { resolve } from "node:path";

const LegacyFiles: readonly string[] = [
    "eslint.config.js",
    "prettier.config.mjs",
    "tools/eslintRules/index.js",
    "tools/eslintRules/rules/no-function-keyword.js",
    "tools/eslintRules/rules/no-multiline-parameters.js",
    "tools/eslintRules/rules/no-undefined-comparison.js",
    "tools/eslintRules/rules/prefer-template-for-string-conversion.js",
    "tools/eslintRules/rules/require-typeof-parentheses.js",
    "tools/eslintRules/rules/require-variable-type.js",
    "tools/eslintRules/rules/variable-naming.js",
    "tools/prettierPlugin/index.mjs",
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
