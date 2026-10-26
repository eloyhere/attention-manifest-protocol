import { ESLintUtils, type TSESTree } from "@typescript-eslint/utils";

const createRule = ESLintUtils.RuleCreator(
    (name) =>
        `https://github.com/attention-manifest-protocol/blob/main/LINTING.md#${name}`,
);

const isStringConstructorCall = (callee: TSESTree.Node): boolean =>
    callee.type === "Identifier" && callee.name === "String";

const getToStringMember = (
    callee: TSESTree.Node,
): TSESTree.MemberExpression | null => {
    if (callee.type !== "MemberExpression") {
        return null;
    }

    if (callee.computed) {
        if (
            callee.property.type === "Literal" &&
            callee.property.value === "toString"
        ) {
            return callee;
        }

        return null;
    }

    if (
        callee.property.type === "Identifier" &&
        callee.property.name === "toString"
    ) {
        return callee;
    }

    return null;
};

export const preferTemplateForStringConversion = createRule({
    name: "prefer-template-for-string-conversion",
    meta: {
        type: "suggestion",
        fixable: "code",
        docs: {
            description:
                "Prefer template literals for string conversion instead of String() or toString()",
        },
        schema: [],
        messages: {
            preferTemplate:
                "字符串转换请使用模板字符串，例如：`${value}`；不要使用 String(value) 或 value.toString()。",
        },
    },
    defaultOptions: [],
    create(context) {
        const sourceCode = context.sourceCode;

        const reportStringCall = (node: TSESTree.CallExpression): void => {
            const argument = node.arguments[0];

            if (!argument || argument.type === "SpreadElement") {
                return;
            }

            context.report({
                node,
                messageId: "preferTemplate",
                fix(fixer) {
                    const argumentText = sourceCode.getText(argument);

                    return fixer.replaceText(
                        node,
                        "`${" + argumentText + "}`",
                    );
                },
            });
        };

        const reportToStringCall = (
            node: TSESTree.CallExpression,
            member: TSESTree.MemberExpression,
        ): void => {
            if (member.object.type === "Super") {
                return;
            }

            context.report({
                node,
                messageId: "preferTemplate",
                fix(fixer) {
                    const objectText = sourceCode.getText(member.object);

                    return fixer.replaceText(
                        node,
                        "`${(" + objectText + ")}`",
                    );
                },
            });
        };

        return {
            CallExpression(node) {
                if (node.optional) {
                    return;
                }

                if (
                    isStringConstructorCall(node.callee) &&
                    node.arguments.length === 1
                ) {
                    reportStringCall(node);
                    return;
                }

                const member = getToStringMember(node.callee);

                if (
                    member &&
                    !member.optional &&
                    node.arguments.length === 0
                ) {
                    reportToStringCall(node, member);
                }
            },
        };
    },
});
