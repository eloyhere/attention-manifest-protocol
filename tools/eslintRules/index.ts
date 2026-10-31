import { jsdocCommentFormat } from "./rules/jsdocCommentFormat.ts";
import { noFunctionKeyword } from "./rules/noFunctionKeyword.ts";
import { noMultilineParameters } from "./rules/noMultilineParameters.ts";
import { noMultilineTypeParameters } from "./rules/noMultilineTypeParameters.ts";
import { noUndefinedComparison } from "./rules/noUndefinedComparison.ts";
import { preferTemplateForStringConversion } from "./rules/preferTemplateForStringConversion.ts";
import { requireTypeofParentheses } from "./rules/requireTypeofParentheses.ts";
import { requireVariableType } from "./rules/requireVariableType.ts";
import { variableNaming } from "./rules/variableNaming.ts";

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
        "prefer-template-for-string-conversion": preferTemplateForStringConversion,
        "require-typeof-parentheses": requireTypeofParentheses,
        "require-variable-type": requireVariableType,
        "variable-naming": variableNaming,
    },
};
