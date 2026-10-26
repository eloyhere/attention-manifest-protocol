import { ESLintUtils, type TSESTree } from "@typescript-eslint/utils";

const createRule = ESLintUtils.RuleCreator((name) => `https://github.com/attention-manifest-protocol/blob/main/LINTING.md#${name}`);

type AnnotatablePattern = TSESTree.Node & {
    typeAnnotation?: TSESTree.TSTypeAnnotation | null;
};

export const requireVariableType = createRule({
    name: "require-variable-type",
    meta: {
        type: "suggestion",
        docs: {
            description: "Require an explicit type annotation on every variable declaration",
        },
        schema: [],
        messages: {
            missingType: "变量声明必须显式标注类型，例如：let studentAge: number = 6;。",
        },
    },
    defaultOptions: [],
    create(context) {
        return {
            VariableDeclarator(node) {
                const pattern = node.id as AnnotatablePattern;

                if (!pattern.typeAnnotation) {
                    context.report({
                        node: node.id,
                        messageId: "missingType",
                    });
                }
            },
        };
    },
});
