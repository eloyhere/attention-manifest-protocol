import { ESLintUtils, type TSESTree } from "@typescript-eslint/utils";

const createRule = ESLintUtils.RuleCreator((name) => `https://github.com/attention-manifest-protocol/blob/main/LINTING.md#${name}`);

const DEFAULT_ALLOW_PATTERNS: readonly string[] = ["^!", "^#", "^eslint-", "^prettier-", "^@ts-", "^@__", "^c8\\b", "^istanbul\\b", "^v8\\b"];

type Options = [
    {
        allowPatterns?: string[];
    },
];

type MessageId = "notJsdoc" | "notMultiline" | "empty";

/**
 * Require every source comment to be a multiline JSDoc block.
 *
 * Tooling directives (`eslint-*`, `@ts-*`, `prettier-*`, `c8`, `istanbul`,
 * `v8`, source-map and shebang comments) are exempt because they are consumed
 * by tools rather than humans. Line comments and ordinary block comments are
 * rejected; JSDoc must open and close on separate lines with a non-empty
 * description.
 */
export const jsdocCommentFormat = createRule<Options, MessageId>({
    name: "jsdoc-comment-format",
    meta: {
        type: "suggestion",
        docs: {
            description: "Require multiline JSDoc comments and reject non-JSDoc comments",
        },
        schema: [
            {
                type: "object",
                properties: {
                    allowPatterns: {
                        type: "array",
                        items: { type: "string" },
                        uniqueItems: true,
                    },
                },
                additionalProperties: false,
            },
        ],
        messages: {
            notJsdoc: "所有注释必须使用 JSDoc：请改为多行 /** ... */ 块，而不是 // 或 /* ... */。",
            notMultiline: "JSDoc 注释必须跨多行：开头的 /**、描述行和结尾的 */ 要各占一行。",
            empty: "JSDoc 注释必须包含非空的描述文本。",
        },
    },
    defaultOptions: [{ allowPatterns: [...DEFAULT_ALLOW_PATTERNS] }],
    create(context) {
        const configured = context.options[0]?.allowPatterns;
        const patterns: readonly string[] = configured ?? DEFAULT_ALLOW_PATTERNS;
        const allowed: readonly RegExp[] = patterns.flatMap((pattern) => {
            try {
                return [new RegExp(pattern)];
            } catch {
                return [];
            }
        });

        const isAllowed = (comment: TSESTree.Comment): boolean => {
            const value = comment.value.trim();
            return allowed.some((pattern) => pattern.test(value));
        };

        const isShebang = (comment: TSESTree.Comment): boolean =>
            comment.loc.start.line === 1 && comment.loc.start.column === 0 && context.sourceCode.text.replace(/^\uFEFF/, "").startsWith("#!");

        const isJsdoc = (comment: TSESTree.Comment): boolean => comment.type === "Block" && comment.value.startsWith("*");

        return {
            Program(): void {
                for (const comment of context.sourceCode.getAllComments()) {
                    if (isAllowed(comment) || isShebang(comment)) {
                        continue;
                    }

                    if (!isJsdoc(comment)) {
                        context.report({
                            loc: comment.loc,
                            messageId: "notJsdoc",
                        });
                        continue;
                    }

                    if (comment.loc.start.line === comment.loc.end.line) {
                        context.report({
                            loc: comment.loc,
                            messageId: "notMultiline",
                        });
                        continue;
                    }

                    if (comment.value.replace(/^\*+/, "").trim().length === 0) {
                        context.report({
                            loc: comment.loc,
                            messageId: "empty",
                        });
                    }
                }
            },
        };
    },
});
