import { ESLintUtils, type TSESLint, type TSESTree } from "@typescript-eslint/utils";

const createRule = ESLintUtils.RuleCreator((name) => `https://github.com/attention-manifest-protocol/blob/main/LINTING.md#${name}`);

const isParenthesized = (sourceCode: Readonly<TSESLint.SourceCode>, node: TSESTree.Node): boolean => {
    const tokenBefore = sourceCode.getTokenBefore(node);
    const tokenAfter = sourceCode.getTokenAfter(node);

    return tokenBefore?.value === "(" && tokenAfter?.value === ")";
};

export const requireTypeofParentheses = createRule({
    name: "require-typeof-parentheses",
    meta: {
        type: "suggestion",
        fixable: "code",
        docs: {
            description: "Require parentheses around the operand of typeof",
        },
        schema: [],
        messages: {
            parenthesize: "typeof 的操作数必须加括号；请写成 typeof(variable)。",
        },
    },
    defaultOptions: [],
    create(context) {
        const sourceCode = context.sourceCode;

        return {
            UnaryExpression(node) {
                if (node.operator !== "typeof") {
                    return;
                }

                if (isParenthesized(sourceCode, node.argument)) {
                    return;
                }

                context.report({
                    node,
                    messageId: "parenthesize",
                    fix(fixer) {
                        return [fixer.insertTextBefore(node.argument, "("), fixer.insertTextAfter(node.argument, ")")];
                    },
                });
            },
        };
    },
});
