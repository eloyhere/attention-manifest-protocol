import { ESLintUtils, type TSESLint, type TSESTree } from "@typescript-eslint/utils";

const createRule = ESLintUtils.RuleCreator((name) => `https://github.com/attention-manifest-protocol/blob/main/README.md#code-style`);

const LOWER_CAMEL_CASE = /^[a-z][a-zA-Z0-9]*$/;
const PASCAL_CASE = /^[A-Z][a-zA-Z0-9]*$/;

const FUNCTION_INITIALIZER_TYPES = new Set(["ArrowFunctionExpression", "FunctionExpression"]);

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

type Naming = "camel" | "pascal";

type FunctionLikeNode = TSESTree.Node & {
    params?: TSESTree.Node[];
};

type NodeWithParent = TSESTree.Node & {
    parent?: TSESTree.Node | null;
};

const getParent = (node: TSESTree.Node): TSESTree.Node | null => (node as NodeWithParent).parent ?? null;

const isTopLevelDeclarator = (declarator: TSESTree.VariableDeclarator): boolean => {
    const declaration = getParent(declarator);
    const container = declaration ? getParent(declaration) : null;

    if (!container) {
        return false;
    }

    if (container.type === "Program") {
        return true;
    }

    return (container.type === "ExportNamedDeclaration" || container.type === "ExportDefaultDeclaration") && getParent(container)?.type === "Program";
};

const isFunctionInitializer = (declarator: TSESTree.VariableDeclarator): boolean => {
    let initializer = declarator.init;

    while (
        initializer &&
        (initializer.type === "TSAsExpression" || initializer.type === "TSSatisfiesExpression" || initializer.type === "TSNonNullExpression")
    ) {
        initializer = initializer.expression;
    }

    return Boolean(initializer && FUNCTION_INITIALIZER_TYPES.has(initializer.type));
};

const collectBindingIdentifiers = (pattern: TSESTree.Node | null | undefined, identifiers: TSESTree.Identifier[] = []): TSESTree.Identifier[] => {
    if (!pattern) {
        return identifiers;
    }

    switch (pattern.type) {
        case "Identifier":
            identifiers.push(pattern);
            break;
        case "ObjectPattern":
            for (const property of pattern.properties) {
                if (property.type === "Property") {
                    collectBindingIdentifiers(property.value, identifiers);
                } else if (property.type === "RestElement") {
                    collectBindingIdentifiers(property.argument, identifiers);
                }
            }
            break;
        case "ArrayPattern":
            for (const element of pattern.elements) {
                collectBindingIdentifiers(element, identifiers);
            }
            break;
        case "AssignmentPattern":
            collectBindingIdentifiers(pattern.left, identifiers);
            break;
        case "RestElement":
            collectBindingIdentifiers(pattern.argument, identifiers);
            break;
        case "TSParameterProperty":
            collectBindingIdentifiers(pattern.parameter, identifiers);
            break;
        default:
            break;
    }

    return identifiers;
};

export const variableNaming = createRule({
    name: "variable-naming",
    meta: {
        type: "suggestion",
        docs: {
            description: "Enforce lower camel case for locals/parameters and PascalCase for top-level data",
        },
        schema: [],
        messages: {
            camel: "变量名 '{{name}}' 必须使用小写开头的驼峰命名（lowerCamelCase）。",
            pascal: "顶层（全局）变量/对象名 '{{name}}' 必须使用大写开头的驼峰命名（PascalCase）。",
        },
    },
    defaultOptions: [],
    create(context) {
        const checkIdentifier = (identifier: TSESTree.Identifier | null | undefined, naming: Naming): void => {
            if (!identifier || identifier.type !== "Identifier" || identifier.name === "this") {
                return;
            }

            const expected = naming === "pascal" ? PASCAL_CASE : LOWER_CAMEL_CASE;
            const messageId = naming === "pascal" ? "pascal" : "camel";

            if (!expected.test(identifier.name)) {
                context.report({
                    node: identifier,
                    messageId,
                    data: {
                        name: identifier.name,
                    },
                });
            }
        };

        const checkParameters = (node: FunctionLikeNode): void => {
            for (const parameter of node.params ?? []) {
                for (const identifier of collectBindingIdentifiers(parameter)) {
                    checkIdentifier(identifier, "camel");
                }
            }
        };

        const checkVariableDeclarator = (node: TSESTree.Node): void => {
            const declarator = node as TSESTree.VariableDeclarator;
            const naming: Naming = isTopLevelDeclarator(declarator) && !isFunctionInitializer(declarator) ? "pascal" : "camel";

            for (const identifier of collectBindingIdentifiers(declarator.id)) {
                checkIdentifier(identifier, naming);
            }
        };

        const checkCatchClause = (node: TSESTree.Node): void => {
            const clause = node as TSESTree.CatchClause;

            for (const identifier of collectBindingIdentifiers(clause.param)) {
                checkIdentifier(identifier, "camel");
            }
        };

        const listeners: Record<string, (node: TSESTree.Node) => void> = {
            VariableDeclarator: checkVariableDeclarator,
            CatchClause: checkCatchClause,
        };

        for (const type of FUNCTION_LIKE_NODE_TYPES) {
            listeners[type] = (node) => {
                checkParameters(node as FunctionLikeNode);
            };
        }

        return listeners as TSESLint.RuleListener;
    },
});
