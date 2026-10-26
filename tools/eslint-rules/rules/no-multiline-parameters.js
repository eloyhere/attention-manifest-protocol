const FUNCTION_LIKE_NODE_TYPES = [
    "FunctionDeclaration",
    "FunctionExpression",
    "ArrowFunctionExpression",
    "TSDeclareFunction",
    "TSEmptyBodyFunctionExpression",
    "TSDeclareMethod",
    "TSFunctionType",
    "TSConstructorType",
    "TSMethodSignature",
    "TSCallSignatureDeclaration",
    "TSConstructSignatureDeclaration",
];

export default {
    meta: {
        type: "suggestion",
        docs: {
            description: "Disallow line breaks between function parameters",
        },
        schema: [],
        messages: {
            lineBreak:
                "参数之间禁止换行；请让所有形参保持在同一行。",
        },
    },
    create(context) {
        const sourceCode = context.sourceCode;

        const check = (node) => {
            const params = node.params;

            if (!Array.isArray(params) || params.length < 2) {
                return;
            }

            for (let index = 0; index < params.length - 1; index += 1) {
                const left = params[index];
                const right = params[index + 1];
                const textBetween = sourceCode
                    .getText()
                    .slice(left.range[1], right.range[0]);

                if (textBetween.includes("\n") || textBetween.includes("\r")) {
                    context.report({
                        node: right,
                        messageId: "lineBreak",
                    });
                    return;
                }
            }
        };

        return Object.fromEntries(
            FUNCTION_LIKE_NODE_TYPES.map((type) => [type, check]),
        );
    },
};
