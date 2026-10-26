import * as prettierEstree from "prettier/plugins/estree";
import * as prettierTypeScript from "prettier/plugins/typescript";

const basePrinter = prettierEstree.printers.estree;
const basePrint = basePrinter.print;

const isZeroLiteral = (node) =>
    node?.type === "Literal" && node.value === 0;

/*
 * Prettier normally removes optional parentheses. These two forms are part of
 * this repository's contract, so they have to be printed explicitly:
 *
 *     typeof(value)   instead of   typeof value
 *     request === (void 0)         instead of   request === void 0
 *
 * The rules are intentionally kept in the printer. An ESLint --fix pass alone
 * would be undone the next time Prettier runs.
 */
const print = (path, options, printChild, args) => {
    const node = path.node;

    if (node.type === "UnaryExpression" && node.operator === "typeof") {
        return ["typeof(", printChild("argument"), ")"];
    }

    if (
        node.type === "UnaryExpression" &&
        node.operator === "void" &&
        isZeroLiteral(node.argument)
    ) {
        return "(void 0)";
    }

    return basePrint(path, options, printChild, args);
};

export const parsers = {
    "amp-typescript": {
        ...prettierTypeScript.parsers.typescript,
        astFormat: "amp-estree",
    },
};

export const printers = {
    "amp-estree": {
        ...basePrinter,
        print,
    },
};
