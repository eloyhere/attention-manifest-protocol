const isParenthesized = (sourceCode, node) => {
    const tokenBefore = sourceCode.getTokenBefore(node);
    const tokenAfter = sourceCode.getTokenAfter(node);

    return tokenBefore?.value === "(" && tokenAfter?.value === ")";
};

export default {
    meta: {
        type: "suggestion",
        fixable: "code",
        docs: {
            description: "Require parentheses around the operand of typeof",
        },
        schema: [],
        messages: {
            parenthesize:
                "typeof 的操作数必须加括号；请写成 typeof(variable)。",
        },
    },
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
                        return [
                            fixer.insertTextBefore(node.argument, "("),
                            fixer.insertTextAfter(node.argument, ")"),
                        ];
                    },
                });
            },
        };
    },
};
