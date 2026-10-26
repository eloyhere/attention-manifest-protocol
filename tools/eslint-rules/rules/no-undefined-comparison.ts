import {
    ESLintUtils,
    type TSESLint,
    type TSESTree,
} from "@typescript-eslint/utils";

const createRule = ESLintUtils.RuleCreator(
    (name) =>
        `https://github.com/attention-manifest-protocol/blob/main/LINTING.md#${name}`,
);

const EQUALITY_OPERATORS = new Set(["==", "===", "!=", "!=="]);

const isUndefined = (node: TSESTree.Node | null | undefined): boolean =>
    node?.type === "Identifier" && node.name === "undefined";

const isZeroLiteral = (node: TSESTree.Node | null | undefined): boolean => {
    if (node?.type !== "Literal") {
        return false;
    }

    return (node as TSESTree.Literal).value === 0;
};

const isVoidZero = (node: TSESTree.Node | null | undefined): boolean => {
    if (node?.type !== "UnaryExpression") {
        return false;
    }

    return node.operator === "void" && isZeroLiteral(node.argument);
};

const isParenthesized = (
    sourceCode: Readonly<TSESLint.SourceCode>,
    node: TSESTree.Node,
): boolean => {
    const tokenBefore = sourceCode.getTokenBefore(node);
    const tokenAfter = sourceCode.getTokenAfter(node);

    return tokenBefore?.value === "(" && tokenAfter?.value === ")";
};

const isLooseOperator = (operator: string): boolean =>
    operator === "==" || operator === "!=";

const needsParentheses = (
    sourceCode: Readonly<TSESLint.SourceCode>,
    node: TSESTree.Node,
): boolean => isVoidZero(node) && !isParenthesized(sourceCode, node);

const fixUndefined = (
    sourceCode: Readonly<TSESLint.SourceCode>,
    fixer: TSESLint.RuleFixer,
    node: TSESTree.Node,
): TSESLint.RuleFix => {
    if (isParenthesized(sourceCode, node)) {
        return fixer.replaceText(node, "void 0");
    }

    return fixer.replaceText(node, "(void 0)");
};

export const noUndefinedComparison = createRule({
    name: "no-undefined-comparison",
    meta: {
        type: "problem",
        fixable: "code",
        docs: {
            description:
                "Require === (void 0) or !== (void 0) instead of comparing with undefined",
        },
        schema: [],
        messages: {
            useVoidZero:
                "禁止与 undefined 比较；请使用 === (void 0) 或 !== (void 0)，且 (void 0) 的括号不可省略。",
        },
    },
    defaultOptions: [],
    create(context) {
        const sourceCode = context.sourceCode;

        return {
            BinaryExpression(node) {
                if (!EQUALITY_OPERATORS.has(node.operator)) {
                    return;
                }

                const operands = [node.left, node.right];
                const hasUndefined = operands.some(isUndefined);
                const hasVoidZero = operands.some(isVoidZero);

                if (!hasUndefined && !hasVoidZero) {
                    return;
                }

                const hasLooseOperator = isLooseOperator(node.operator);
                const hasUnparenthesizedVoidZero = operands.some((operand) =>
                    needsParentheses(sourceCode, operand),
                );

                if (
                    !hasLooseOperator &&
                    !hasUndefined &&
                    !hasUnparenthesizedVoidZero
                ) {
                    return;
                }

                context.report({
                    node,
                    messageId: "useVoidZero",
                    fix(fixer) {
                        const fixes: TSESLint.RuleFix[] = [];

                        if (hasLooseOperator) {
                            const operatorToken =
                                sourceCode.getFirstTokenBetween(
                                    node.left,
                                    node.right,
                                    {
                                        filter: (token) =>
                                            token.value === node.operator,
                                    },
                                );

                            if (operatorToken) {
                                fixes.push(
                                    fixer.replaceText(
                                        operatorToken,
                                        node.operator === "==" ? "===" : "!==",
                                    ),
                                );
                            }
                        }

                        for (const operand of operands) {
                            if (isUndefined(operand)) {
                                fixes.push(
                                    fixUndefined(sourceCode, fixer, operand),
                                );
                                continue;
                            }

                            if (needsParentheses(sourceCode, operand)) {
                                fixes.push(
                                    fixer.insertTextBefore(operand, "("),
                                    fixer.insertTextAfter(operand, ")"),
                                );
                            }
                        }

                        return fixes;
                    },
                });
            },
        };
    },
});
