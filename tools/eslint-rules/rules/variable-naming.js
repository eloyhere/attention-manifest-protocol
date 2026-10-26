const LOWER_CAMEL_CASE = /^[a-z][a-zA-Z0-9]*$/;
const PASCAL_CASE = /^[A-Z][a-zA-Z0-9]*$/;

const FUNCTION_INITIALIZER_TYPES = new Set([
    "ArrowFunctionExpression",
    "FunctionExpression",
]);

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

const isTopLevelDeclarator = (declarator) => {
    const declaration = declarator.parent;
    const container = declaration?.parent;

    if (!container) {
        return false;
    }

    if (container.type === "Program") {
        return true;
    }

    return (
        (container.type === "ExportNamedDeclaration" ||
            container.type === "ExportDefaultDeclaration") &&
        container.parent?.type === "Program"
    );
};

const isFunctionInitializer = (declarator) => {
    let initializer = declarator.init;

    while (
        initializer &&
        (initializer.type === "TSAsExpression" ||
            initializer.type === "TSSatisfiesExpression" ||
            initializer.type === "TSNonNullExpression")
    ) {
        initializer = initializer.expression;
    }

    return Boolean(
        initializer && FUNCTION_INITIALIZER_TYPES.has(initializer.type),
    );
};

const collectBindingIdentifiers = (pattern, identifiers = []) => {
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

export default {
    meta: {
        type: "suggestion",
        docs: {
            description:
                "Enforce lower camel case for locals/parameters and PascalCase for top-level data",
        },
        schema: [],
        messages: {
            camel:
                "变量名 '{{name}}' 必须使用小写开头的驼峰命名（lowerCamelCase）。",
            pascal:
                "顶层（全局）变量/对象名 '{{name}}' 必须使用大写开头的驼峰命名（PascalCase）。",
        },
    },
    create(context) {
        const checkIdentifier = (identifier, naming) => {
            if (
                !identifier ||
                identifier.type !== "Identifier" ||
                identifier.name === "this"
            ) {
                return;
            }

            const expected =
                naming === "pascal" ? PASCAL_CASE : LOWER_CAMEL_CASE;
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

        const checkParameters = (node) => {
            for (const parameter of node.params ?? []) {
                for (const identifier of collectBindingIdentifiers(parameter)) {
                    checkIdentifier(identifier, "camel");
                }
            }
        };

        const visitors = {
            VariableDeclarator(node) {
                const naming =
                    isTopLevelDeclarator(node) && !isFunctionInitializer(node)
                        ? "pascal"
                        : "camel";

                for (const identifier of collectBindingIdentifiers(node.id)) {
                    checkIdentifier(identifier, naming);
                }
            },
            CatchClause(node) {
                for (const identifier of collectBindingIdentifiers(node.param)) {
                    checkIdentifier(identifier, "camel");
                }
            },
        };

        for (const type of FUNCTION_LIKE_NODE_TYPES) {
            visitors[type] = checkParameters;
        }

        return visitors;
    },
};
