import { ESLintUtils, type TSESLint, type TSESTree } from "@typescript-eslint/utils";

const createRule = ESLintUtils.RuleCreator((name) => `https://github.com/attention-manifest-protocol/blob/main/README.md#code-style`);

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
] as const;

type FunctionLikeNode = TSESTree.Node & {
    params?: TSESTree.Node[];
};

export const noMultilineParameters = createRule({
    name: "no-multiline-parameters",
    meta: {
        type: "suggestion",
        docs: {
            description: "Disallow line breaks between function parameters",
        },
        schema: [],
        messages: {
            lineBreak: "参数之间禁止换行；请让所有形参保持在同一行。",
        },
    },
    defaultOptions: [],
    create(context) {
        const sourceCode = context.sourceCode;

        const check = (node: FunctionLikeNode): void => {
            const params = node.params;

            if (!Array.isArray(params) || params.length < 2) {
                return;
            }

            for (let index = 0; index < params.length - 1; index += 1) {
                const left = params[index];
                const right = params[index + 1];
                const textBetween = sourceCode.getText().slice(left.range[1], right.range[0]);

                if (textBetween.includes("\n") || textBetween.includes("\r")) {
                    context.report({
                        node: right,
                        messageId: "lineBreak",
                    });
                    return;
                }
            }
        };

        const listeners: Record<string, (node: TSESTree.Node) => void> = {};

        for (const type of FUNCTION_LIKE_NODE_TYPES) {
            listeners[type] = (node) => {
                check(node as FunctionLikeNode);
            };
        }

        return listeners as TSESLint.RuleListener;
    },
});
