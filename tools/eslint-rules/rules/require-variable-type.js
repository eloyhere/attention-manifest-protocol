export default {
    meta: {
        type: "suggestion",
        docs: {
            description: "Require an explicit type annotation on every variable declaration",
        },
        schema: [],
        messages: {
            missingType:
                "变量声明必须显式标注类型，例如：let studentAge: number = 6;。",
        },
    },
    create(context) {
        return {
            VariableDeclarator(node) {
                if (!node.id.typeAnnotation) {
                    context.report({
                        node: node.id,
                        messageId: "missingType",
                    });
                }
            },
        };
    },
};
