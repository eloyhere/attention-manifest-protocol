import { jsdocCommentFormat } from "./rules/jsdoc-comment-format.ts";
import { noFunctionKeyword } from "./rules/no-function-keyword.ts";
import { noMultilineParameters } from "./rules/no-multiline-parameters.ts";
import { noMultilineTypeParameters } from "./rules/no-multiline-type-parameters.ts";
import { noUndefinedComparison } from "./rules/no-undefined-comparison.ts";
import { preferTemplateForStringConversion } from "./rules/prefer-template-for-string-conversion.ts";
import { requireTypeofParentheses } from "./rules/require-typeof-parentheses.ts";
import { requireVariableType } from "./rules/require-variable-type.ts";
import { variableNaming } from "./rules/variable-naming.ts";

export default {
    meta: {
        name: "amp-local-rules",
    },
    rules: {
        "jsdoc-comment-format": jsdocCommentFormat,
        "no-function-keyword": noFunctionKeyword,
        "no-multiline-parameters": noMultilineParameters,
        "no-multiline-type-parameters": noMultilineTypeParameters,
        "no-undefined-comparison": noUndefinedComparison,
        "prefer-template-for-string-conversion":
            preferTemplateForStringConversion,
        "require-typeof-parentheses": requireTypeofParentheses,
        "require-variable-type": requireVariableType,
        "variable-naming": variableNaming,
    },
};
