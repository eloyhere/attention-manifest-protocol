const EQUALITY_OPERATORS = new Set(["==", "===", "!=", "!=="]);

const isUndefined = (node) =>
    node?.type === "Identifier" && node.name === "undefined";

const isZeroLiteral = (node) =>
    node?.type === "Literal" && node.value === 0;

const isVoidZero = (node) =>
    node?.type === "UnaryExpression" &&
    node.operator === "void" &&
    isZeroLiteral(node.argument);

const isParenthesized = (sourceCode, node) => {
    const tokenBefore = sourceCode.getTokenBefore(node);
    const tokenAfter = sourceCode.getTokenAfter(node);

    return tokenBefore?.value === "(" && tokenAfter?.value === ")";
};

const isLooseOperator = (operator) => operator === "==" || operator === "!=";

const needsParentheses = (sourceCode, node) =>
    isVoidZero(node) && !isParenthesized(sourceCode, node);

const fixUndefined = (sourceCode, fixer, node) => {
    if (isParenthesized(sourceCode, node)) {
        return fixer.replaceText(node, "void 0");
    }

    return fixer.replaceText(node, "(void 0)");
};

export default {
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
                        const fixes = [];

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
};
