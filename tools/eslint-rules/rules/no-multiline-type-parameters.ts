import { ESLintUtils, type TSESTree } from "@typescript-eslint/utils";

const createRule = ESLintUtils.RuleCreator((name) => `https://github.com/attention-manifest-protocol/blob/main/LINTING.md#${name}`);

/*
 * Keep this heuristic in sync with the `amp-typescript` printer in
 * tools/prettier-plugin/index.mts. A type-parameter list that contains a
 * comment is printed by the stock Prettier printer, so the rule must not
 * report a line break that Prettier itself produces.
 */
const HAS_COMMENT = /\/[/*]/u;

export const noMultilineTypeParameters = createRule({
    name: "no-multiline-type-parameters",
    meta: {
        type: "suggestion",
        docs: {
            description: "Disallow line breaks between type parameters",
        },
        schema: [],
        messages: {
            lineBreak: "类型参数之间禁止换行；请让所有类型参数保持在同一行。",
        },
    },
    defaultOptions: [],
    create(context) {
        const sourceCode = context.sourceCode;

        return {
            TSTypeParameterDeclaration(node): void {
                const parameters: TSESTree.TSTypeParameter[] = node.params;

                if (parameters.length < 2) {
                    return;
                }

                if (HAS_COMMENT.test(sourceCode.getText(node))) {
                    return;
                }

                for (let index = 0; index < parameters.length - 1; index += 1) {
                    const left = parameters[index];
                    const right = parameters[index + 1];
                    const textBetween = sourceCode.getText().slice(left.range[1], right.range[0]);

                    if (textBetween.includes("\n") || textBetween.includes("\r")) {
                        context.report({
                            node: right,
                            messageId: "lineBreak",
                        });
                        return;
                    }
                }
            },
        };
    },
});
