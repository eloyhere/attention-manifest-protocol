import stylistic from "@stylistic/eslint-plugin";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

import localRules from "./tools/eslintRules/index.ts";

/**
 * ESLint enforces the rules that Prettier cannot express:
 *   - explicit variable types
 *   - no `function` keyword
 *   - no line break between parameters
 *   - no line break between type parameters
 *   - template literals for string conversion / concatenation
 *   - canonical `(void 0)` comparisons
 *   - `typeof(value)`
 *   - lowerCamelCase locals and PascalCase top-level data
 *   - multiline JSDoc-only comments
 *   - mandatory braces around control-flow bodies
 *
 * Prettier owns indentation (4 spaces), semicolons, quotes and ordinary line
 * wrapping. There is deliberately no ESLint `indent` rule, so the two tools do
 * not fight over layout. The local Prettier printer preserves `typeof(value)`
 * and `(void 0)`, and keeps type-parameter lists on one line; see
 * prettier.config.mts.
 */
export default defineConfig([
    {
        ignores: [
            "**/node_modules/**",
            "**/dist/**",
            "**/*.js",
            "**/*.mjs",
            "**/*.cjs",
            "docs/**",
            "public/**",
            "eslint.config.mts",
            "prettier.config.mts",
            "tools/eslintRules/**",
            "tools/prettierPlugin/**",
        ],
    },
    ...tseslint.configs.recommended,
    {
        files: ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts"],
        plugins: {
            "@stylistic": stylistic,
            local: localRules,
        },
        languageOptions: {
            parserOptions: {
                ecmaVersion: "latest",
                sourceType: "module",
            },
        },
        rules: {
            "local/jsdoc-comment-format": "error",
            "local/require-variable-type": "error",
            "local/no-function-keyword": "error",
            "local/no-multiline-parameters": "error",
            "local/no-multiline-type-parameters": "error",
            "local/prefer-template-for-string-conversion": "error",
            "local/no-undefined-comparison": "error",
            "local/require-typeof-parentheses": "error",
            "local/variable-naming": "error",

            "prefer-template": "error",
            "curly": ["error", "all"],

            "@stylistic/semi": ["error", "always"],
            "@stylistic/no-extra-semi": "error",
            "@stylistic/quotes": [
                "error",
                "double",
                {
                    avoidEscape: true,
                    allowTemplateLiterals: "always",
                },
            ],
            "@stylistic/jsx-quotes": ["error", "prefer-double"],
            "@stylistic/member-delimiter-style": [
                "error",
                {
                    multiline: {
                        delimiter: "semi",
                        requireLast: true,
                    },
                    singleline: {
                        delimiter: "semi",
                        requireLast: true,
                    },
                    multilineDetection: "brackets",
                },
            ],
        },
    },
]);
