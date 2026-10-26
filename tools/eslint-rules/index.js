import noFunctionKeyword from "./rules/no-function-keyword.js";
import noMultilineParameters from "./rules/no-multiline-parameters.js";
import noUndefinedComparison from "./rules/no-undefined-comparison.js";
import preferTemplateForStringConversion from "./rules/prefer-template-for-string-conversion.js";
import requireTypeofParentheses from "./rules/require-typeof-parentheses.js";
import requireVariableType from "./rules/require-variable-type.js";
import variableNaming from "./rules/variable-naming.js";

export default {
    meta: {
        name: "amp-local-rules",
    },
    rules: {
        "no-function-keyword": noFunctionKeyword,
        "no-multiline-parameters": noMultilineParameters,
        "no-undefined-comparison": noUndefinedComparison,
        "prefer-template-for-string-conversion":
            preferTemplateForStringConversion,
        "require-typeof-parentheses": requireTypeofParentheses,
        "require-variable-type": requireVariableType,
        "variable-naming": variableNaming,
    },
};
