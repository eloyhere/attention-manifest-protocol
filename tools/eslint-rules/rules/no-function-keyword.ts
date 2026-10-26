import { ESLintUtils, type TSESLint, type TSESTree } from "@typescript-eslint/utils";

const createRule = ESLintUtils.RuleCreator(
    (name) =>
        `https://github.com/attention-manifest-protocol/blob/main/LINTING.md#${name}`,
);

const isKeywordFunctionExpression = (
    sourceCode: Readonly<TSESLint.SourceCode>,
    node: TSESTree.FunctionExpression,
): boolean => {
    const firstToken = sourceCode.getFirstToken(node);

    if (!firstToken) {
        return false;
    }

    if (firstToken.value === "function") {
        return true;
    }

    if (firstToken.value !== "async") {
        return false;
    }

    const nextToken = sourceCode.getTokenAfter(firstToken);

    return nextToken?.value === "function";
};

export const noFunctionKeyword = createRule({
    name: "no-function-keyword",
    meta: {
        type: "problem",
        docs: {
            description: "Disallow the function keyword; use arrow functions instead",
        },
        schema: [],
        messages: {
            noFunction:
                "禁止使用 function 关键字；请改用箭头函数，例如：const add = (a: number, b: number): number => a + b;。",
        },
    },
    defaultOptions: [],
    create(context) {
        const sourceCode = context.sourceCode;

        return {
            FunctionDeclaration(node) {
                context.report({ node, messageId: "noFunction" });
            },
            FunctionExpression(node) {
                /*
                 * In the ESTree AST a method body is also a FunctionExpression,
                 * even though no `function` token exists. Only report the ones
                 * that really use the keyword.
                 */
                if (isKeywordFunctionExpression(sourceCode, node)) {
                    context.report({ node, messageId: "noFunction" });
                }
            },
            TSDeclareFunction(node) {
                context.report({ node, messageId: "noFunction" });
            },
        };
    },
});
