import type { Config } from "prettier";

import * as ampPrettierPlugin from "./tools/prettierPlugin/index.mts";

/**
 * Prettier owns layout: indentation, semicolons, quotes and ordinary wrapping.
 * The local plugin keeps the two non-standard forms that the project requires:
 * `typeof(value)` and `(void 0)`.
 *
 * Comment shape and mandatory braces are enforced by ESLint instead; Prettier
 * formats their interior layout but does not add missing braces or JSDoc tags.
 *
 * @see https://prettier.io/docs/configuration
 */
const config: Config = {
    plugins: [ampPrettierPlugin],
    tabWidth: 4,
    useTabs: false,
    semi: true,
    singleQuote: false,
    jsxSingleQuote: false,
    bracketSpacing: true,
    trailingComma: "all",
    arrowParens: "always",
    printWidth: 160,
    endOfLine: "lf",
    overrides: [
        {
            files: ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts"],
            options: {
                parser: "amp-typescript",
            },
        },
    ],
};

export default config;
