import { doc, type Parser, type Printer } from "prettier";
import * as prettierEstree from "prettier/plugins/estree";
import * as prettierTypeScript from "prettier/plugins/typescript";

const basePrinter: Printer = prettierEstree.printers.estree;
const basePrint = basePrinter.print;

const isZeroLiteral = (node: unknown): boolean => {
    if (typeof(node) !== "object" || node === null) {
        return false;
    }

    const record = node as { type?: string; value?: unknown };

    return record.type === "Literal" && record.value === 0;
};

/*
 * Prettier owns layout, but three forms are part of this repository's contract
 * and have to be printed explicitly:
 *
 *     typeof(value)                  instead of   typeof value
 *     request === (void 0)           instead of   request === void 0
 *     class Service<TEntity, TKey>   instead of   one type parameter per line
 *
 * The rules are intentionally kept in the printer. An ESLint --fix pass alone
 * would be undone the next time Prettier runs.
 */
const hasComment = (text: string): boolean => text.includes("/*") || text.includes("//");

const print: Printer["print"] = (path, options, printChild, args) => {
    const node = path.node;

    /*
     * Rebuild the type-parameter list without any line doc so that Prettier
     * cannot split it, even past `printWidth`. Lists that contain comments are
     * left to the default printer; flattening would pull the comment out of
     * its JSDoc shape.
     */
    if (node.type === "TSTypeParameterDeclaration") {
        const text = options.originalText.slice(options.locStart(node), options.locEnd(node));

        if (!hasComment(text)) {
            const parameters = path.map((parameterPath) => doc.utils.removeLines(printChild(parameterPath)), "params");

            /*
             * In .tsx a single unconstrained parameter on an arrow function
             * needs a trailing comma, otherwise `<T>` is parsed as JSX. This
             * mirrors the stock TypeScript printer.
             */
            const needsTrailingComma =
                path.parent?.type === "ArrowFunctionExpression" &&
                node.params.length === 1 &&
                !node.params[0].constraint &&
                !(options.filepath && /\.ts$/.test(options.filepath));

            return ["<", doc.builders.join(", ", parameters), needsTrailingComma ? "," : "", ">"];
        }
    }

    if (node.type === "UnaryExpression" && node.operator === "typeof") {
        return ["typeof(", printChild("argument"), ")"];
    }

    if (node.type === "UnaryExpression" && node.operator === "void" && isZeroLiteral(node.argument)) {
        return "(void 0)";
    }

    return basePrint(path, options, printChild, args);
};

export const parsers: Record<string, Parser> = {
    "amp-typescript": {
        ...prettierTypeScript.parsers.typescript,
        astFormat: "amp-estree",
    },
};

export const printers: Record<string, Printer> = {
    "amp-estree": {
        ...basePrinter,
        print,
    },
};
