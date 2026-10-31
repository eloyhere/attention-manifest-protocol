/**
 * Visual Basic (.NET) outline strategy.
 *
 * VB has no braces and no significant indentation: a block opens on a
 * declaration line (`Namespace`, `Class`, `Module`, `Sub`, `Property`, ...) and
 * closes on a matching `End <keyword>` line. The scanner is therefore a bounded
 * line machine with an `End` stack. It never builds a grammar or a symbol table;
 * it reports declarations and their line ranges, which is what an outline needs.
 *
 * The module is self-contained on purpose. `outlineStrategies.ts` is not edited
 * here, so `parseVisualBasic` and `VisualBasicStrategy` are exported for the host
 * to register when it adopts VB. `parseVisualBasic` is a pure function of the
 * decoded text, so a test can call it with a synthetic `OutlineParseInput` and
 * does not need the default registry.
 *
 * Boundary rules (each one is covered by `tools/visualBasicOutlineCheck.ts`):
 *
 * - `'` and `REM` comments and `"..."` literals are masked before detection, so
 *   a `Class`/`Sub` inside a comment or a string never produces a node, and an
 *   `End Class` inside a string never closes a block;
 * - a `<Attribute>` line produces no node, and a leading attribute list on a
 *   declaration line is skipped;
 * - a trailing `_` continuation joins physical lines into one logical line, so
 *   a signature or `As` clause split across lines still declares the node and
 *   reports the physical lines it occupies;
 * - `Sub`/`Function` become `method`/`function`, `Property` and field
 *   declarations (`Dim`/`Const` plus `As`, or an access modifier plus `As`)
 *   become `property`, and enum members become `constant`; an enum body reports
 *   constants only, so a malformed declaration inside it cannot leak a node;
 * - `Delegate Sub`/`Delegate Function` become `type`, a plain `Event` becomes a
 *   one-line `property`, `Custom Event` spans to `End Event`, and an `Operator`
 *   overload becomes a `method` spanning to `End Operator`;
 * - `Dim a As Integer, b As String` reports one node per declarator, and a
 *   `.vbs` file (VBScript is untyped) also reports a bare `Private _value`
 *   class field;
 * - `Shared` (VB's `static`) and every other recognized modifier are reported
 *   lowercase, in source order;
 * - a multi-line lambda (`Dim f As Func(Of Integer, Integer) =
 *   Function(x As Integer)`, `AddHandler x, Sub()`, `Return Function()`) pushes
 *   an anonymous `End` frame, so its `End Function` cannot close the enclosing
 *   method, while a single-line lambda pushes nothing;
 * - an auto-implemented property (`Public Property Name As String` with no
 *   accessor line) stays a one-line node instead of swallowing the next member,
 *   while a property whose body starts with `Get`/`Set` spans to `End Property`;
 * - a keyword is matched case-insensitively, because VB source is not
 *   case-sensitive.
 *
 * The recognized modifier chain is the documented set
 * (`Public`/`Private`/`Protected`/`Friend`/`Shared`/`Overrides`/`Overloads`/
 * `MustOverride`/`NotOverridable`/`Async`/`Partial`/`ReadOnly`/`WriteOnly`/
 * `Default`/`Shadows`) plus the VB modifiers that would otherwise hide the
 * declaration behind them (`MustInherit`, `NotInheritable`, `Overridable`,
 * `WithEvents`, `Iterator`, `Custom`). All of them are reported lowercase.
 *
 * Remaining limits, documented rather than silently guessed:
 *
 * - a continuation that ends inside an unterminated string literal is treated
 *   as code up to the end of its physical line, because a VB literal cannot
 *   span lines;
 * - a field without `As` in a `.vb` file (`Dim x` with no type) is not a node;
 *   VBScript-style untyped fields are recognized only for `.vbs`;
 * - `End` frames are matched by keyword and popped from the innermost frame, so
 *   a file with a missing `End Sub`/`End Class` closes at EOF instead of
 *   guessing where the block ended.
 */
import { OutlineKeywordRegistry } from "./outlineKeywords.ts";
import type { OutlineMatchInput, OutlineParseInput, OutlineStrategy } from "./strategy.ts";
import type { OutlineKind, OutlineNode } from "./types.ts";

/**
 * One logical line: physical lines joined by a trailing `_` continuation. The
 * line numbers keep the physical span so a continued declaration reports the
 * lines it really occupies.
 */
interface VisualBasicLine {
    readonly code: string;
    readonly masked: string;
    readonly startLine: number;
    readonly endLine: number;
}

/**
 * Mutable draft node. `endLine` starts on the declaration line (or the last
 * physical line of a continued declaration) and is patched when the closing
 * `End` line is seen; a block that never closes keeps the last line of the file.
 */
interface VisualBasicDraft {
    readonly label: string;
    readonly kind: OutlineKind;
    readonly startLine: number;
    endLine: number;
    readonly depth: number;
    readonly detail: string;
    readonly modifiers: readonly string[];
    readonly children: VisualBasicDraft[];
}

/**
 * One open block. `end` is the lowercase keyword its `End` line must carry;
 * `container` marks a block that owns members (a type or namespace) as opposed
 * to a body (a method, a property or an anonymous lambda). A lambda frame owns
 * no node, so it only keeps the `End` stack balanced.
 */
interface VisualBasicFrame {
    readonly end: string;
    readonly container: boolean;
    readonly node?: VisualBasicDraft;
}

/**
 * One physical line in two views: `code` keeps string literals and drops the
 * trailing comment (for labels and details), `masked` blanks string contents and
 * the comment (for detection, so a quoted `Class` cannot match).
 */
interface VisualBasicMasked {
    readonly code: string;
    readonly masked: string;
}

/**
 * Leading words of a declaration line: the modifier chain and what remains.
 */
interface VisualBasicHeader {
    readonly modifiers: readonly string[];
    readonly rest: string;
}

/**
 * Modifier chain, lowercase so classification is case-insensitive. The first
 * block is the documented VB set; the second block carries modifiers that are
 * common in real source and would otherwise hide the declaration they precede
 * (`Custom` also marks a `Custom Event` block).
 */
const VisualBasicModifierWords: readonly string[] = [
    "public",
    "private",
    "protected",
    "friend",
    "shared",
    "overrides",
    "overloads",
    "mustoverride",
    "notoverridable",
    "async",
    "partial",
    "readonly",
    "writeonly",
    "default",
    "shadows",
    "mustinherit",
    "notinheritable",
    "overridable",
    "withevents",
    "iterator",
    "custom",
];

/**
 * Local keyword registry. It is a private instance, not `DefaultOutlineKeywords`,
 * because VB words are matched case-insensitively and include words the shared
 * registry does not carry. Creating a local registry leaves the shared one
 * untouched, so C#/TypeScript outlines keep their current behavior.
 */
const VisualBasicKeywords: OutlineKeywordRegistry = new OutlineKeywordRegistry();
VisualBasicModifierWords.forEach((word: string): void => {
    VisualBasicKeywords.register("modifier", word);
});
["dim", "const"].forEach((word: string): void => {
    VisualBasicKeywords.register("variable", word);
});

/**
 * Outline kind of each block keyword. `Structure` maps to `struct`, the
 * language-neutral value for a value type.
 */
const VisualBasicBlockKinds: ReadonlyMap<string, OutlineKind> = new Map<string, OutlineKind>([
    ["class", "class"],
    ["module", "module"],
    ["structure", "struct"],
    ["interface", "interface"],
    ["enum", "enum"],
]);

/**
 * Kinds that own members. A namespace contains types but no members, and an
 * enum owns `constant` members only.
 */
const VisualBasicMemberOwners: ReadonlySet<OutlineKind> = new Set<OutlineKind>(["class", "module", "struct", "interface"]);

/**
 * File extensions the strategy claims. `.vb` is VB.NET source; `.vbs` is
 * VBScript, which uses the same block-keyword grammar.
 */
const VisualBasicExtensions: readonly string[] = [".vb", ".vbs"];

/**
 * One identifier: a plain word or a bracketed escape such as `[Class]`. VB.NET
 * identifiers are Unicode, so the word classes are `\p{L}`/`\p{N}` rather than
 * `\w`, which is ASCII-only in JavaScript.
 */
const IdentifierPattern: string = String.raw`\[[^\]\r\n]+\]|[\p{L}_][\p{L}\p{N}_]*`;

/**
 * Block-closing line. Only the keywords this scanner opens are listed, so
 * `End If`, `End While`, `End Using` and `End Try` inside a body are ignored
 * instead of closing the enclosing method.
 */
const EndBlockPattern: RegExp = new RegExp(`^end\\s+(namespace|class|module|structure|interface|enum|sub|function|property|event|operator)\\b`, "iu");

/**
 * `Namespace Acme.Tools` (a dotted name is captured whole).
 */
const NamespacePattern: RegExp = new RegExp(`^namespace\\s+([\\p{L}_][\\p{L}\\p{N}_.]*)\\s*$`, "iu");

/**
 * `Class`, `Module`, `Structure`, `Interface` and `Enum` block headers.
 */
const BlockPattern: RegExp = new RegExp(`^(class|module|structure|interface|enum)\\s+(${IdentifierPattern})`, "iu");

/**
 * `Declare Sub`/`Declare Function` (a P/Invoke signature without a body). The
 * optional `Auto`/`Ansi`/`Unicode` charset word comes between `Declare` and the
 * member keyword.
 */
const DeclarePattern: RegExp = new RegExp(`^declare\\s+(?:(?:auto|ansi|unicode)\\s+)*(sub|function)\\s+(${IdentifierPattern})`, "iu");

/**
 * `Sub`/`Function` member headers.
 */
const MethodPattern: RegExp = new RegExp(`^(sub|function)\\s+(${IdentifierPattern})`, "iu");

/**
 * `Property` headers. The optional `Get`/`Let`/`Set` word is VB6/VBScript
 * syntax (`Public Property Get Name()`); `.vbs` files use it, and the block
 * still closes on `End Property`.
 */
const PropertyPattern: RegExp = new RegExp(`^property\\s+(?:(get|let|set)\\s+)?(${IdentifierPattern})`, "iu");

/**
 * `Delegate Sub`/`Delegate Function`: a delegate type declaration. It is a
 * type, so it maps to the `type` kind instead of a method.
 */
const DelegatePattern: RegExp = new RegExp(`^delegate\\s+(sub|function)\\s+(${IdentifierPattern})`, "iu");

/**
 * `Event Name As Type`. A plain event is a member declaration (a `property`);
 * a `Custom Event` is a block closed by `End Event`.
 */
const EventPattern: RegExp = new RegExp(`^event\\s+(${IdentifierPattern})`, "iu");

/**
 * `Operator +`, `Operator CType`, ...: VB declares an operator overload as a
 * shared method with a body, closed by `End Operator`. The symbol is captured up
 * to its parameter list.
 */
const OperatorPattern: RegExp = new RegExp(`^operator\\s+([^\\s(]+)`, "iu");

/**
 * Field declaration: a name (optionally followed by an array suffix) and an
 * `As <type>` clause. The modifier chain and any `Dim`/`Const` word were removed
 * before this pattern runs.
 */
const FieldPattern: RegExp = new RegExp(`^(${IdentifierPattern})\\s*(?:\\([^)]*\\))?\\s+as\\s+\\S`, "iu");

/**
 * Untyped VBScript field: a bare name with an optional initializer.
 */
const UntypedFieldPattern: RegExp = new RegExp(`^(${IdentifierPattern})\\s*(?:=\\s*.*)?$`, "iu");

/**
 * Enum member: a name with an optional initializer.
 */
const EnumMemberPattern: RegExp = new RegExp(`^(${IdentifierPattern})\\s*(?:=\\s*(.*))?$`, "iu");

/**
 * Accessor line that opens a full property body: `Get`, `Set`, or the
 * parenthesized `Set(value As String)` form.
 */
const AccessorPattern: RegExp = /^(?:get|set)\s*(?:\(.*\))?$/i;

/**
 * A lambda keyword that starts a value or a statement: `= Sub()`, `, Function(x)`
 * or `Return Function(x)`. A plain member declaration never matches, because its
 * keyword is not preceded by `=`, `(`, `,` or `Return`.
 */
const LambdaOpenerPattern: RegExp = /(?:^|[=(,]\s*|\breturn\s+)(?:async\s+)?(sub|function)\s*\(/iu;

/**
 * One or more leading `<Attribute(...)>` groups.
 */
const AttributePrefixPattern: RegExp = /^(?:<[^<>]*>\s*)+/u;

/**
 * One leading word followed by whitespace.
 */
const WordPattern: RegExp = /^([\p{L}_][\p{L}\p{N}_]*)\s+/u;

/**
 * Last path segment, so a matcher also accepts a full path.
 */
const baseNameOf: (path: string) => string = (path: string): string => {
    const slash: number = path.lastIndexOf("/");
    return slash === -1 ? path : path.slice(slash + 1);
};

/**
 * Whether a base name carries one of the given extensions, case-insensitively.
 */
const hasExtension: (name: string, extensions: readonly string[]) => boolean = (name: string, extensions: readonly string[]): boolean => {
    const dot: number = name.lastIndexOf(".");
    if (dot <= 0 || dot === name.length - 1) {
        return false;
    }
    return extensions.includes(name.slice(dot).toLowerCase());
};

/**
 * Split a decoded text into physical lines: `\n` separates, a trailing newline
 * does not add a phantom line, and a `\r` before the `\n` is dropped so CRLF and
 * LF files report the same line numbers.
 */
const splitSourceLines: (text: string) => string[] = (text: string): string[] => {
    if (text.length === 0) {
        return [];
    }
    const lines: string[] = text.split("\n");
    if (lines[lines.length - 1] === "") {
        lines.pop();
    }
    return lines.map((line: string): string => (line.endsWith("\r") ? line.slice(0, -1) : line));
};

/**
 * Whether a code line ends with the VB line-continuation underscore. The
 * underscore must follow whitespace, so an identifier such as `total_` is not a
 * continuation.
 */
const isContinuation: (code: string) => boolean = (code: string): boolean => /(?:^|[ \t])_$/u.test(code.trimEnd());

/**
 * Remove the continuation underscore and the whitespace around it.
 */
const trimContinuation: (code: string) => string = (code: string): string => code.trimEnd().slice(0, -1).trimEnd();

/**
 * Whether the word at one offset starts a `REM` comment.
 *
 * `REM` is a comment only at the start of a statement, so `Remember` and
 * `total = a + Rem` stay code. The caller has already handled string literals,
 * so a quoted `"REM"` never reaches this function.
 */
const isRemComment: (line: string, index: number) => boolean = (line: string, index: number): boolean => {
    if (line.slice(index, index + 3).toLowerCase() !== "rem") {
        return false;
    }
    const after: string = line.slice(index + 3, index + 4);
    if (after.length > 0 && !/[ \t:]/.test(after)) {
        return false;
    }
    for (let cursor: number = index - 1; cursor >= 0; cursor -= 1) {
        const previous: string = line[cursor];
        if (previous === " " || previous === "\t") {
            continue;
        }
        return previous === ":";
    }
    return true;
};

/**
 * Build the code and detection views of one physical line.
 *
 * A doubled quote (`""`) is the VB escape inside a literal; an unterminated
 * literal runs to the end of the line because a VB literal cannot span lines.
 * The trailing comment is dropped from both views, which is what keeps a quoted
 * or commented `End Class` out of the block stack.
 */
const maskLine: (raw: string) => VisualBasicMasked = (raw: string): VisualBasicMasked => {
    const code: string[] = [];
    const masked: string[] = [];
    let inString: boolean = false;
    let index: number = 0;
    while (index < raw.length) {
        const character: string = raw[index];
        if (inString) {
            if (character !== '"') {
                code.push(character);
                masked.push(" ");
                index += 1;
                continue;
            }
            if (raw[index + 1] === '"') {
                code.push('""');
                masked.push("  ");
                index += 2;
                continue;
            }
            inString = false;
            code.push(character);
            masked.push(character);
            index += 1;
            continue;
        }
        if (character === '"') {
            inString = true;
            code.push(character);
            masked.push(character);
            index += 1;
            continue;
        }
        if (character === "'" || isRemComment(raw, index)) {
            break;
        }
        code.push(character);
        masked.push(character);
        index += 1;
    }
    return { code: code.join(""), masked: masked.join("") };
};

/**
 * Merge physical lines joined by a trailing `_` into logical lines. A
 * declaration continued over several lines therefore declares exactly once and
 * still reports the physical span it occupies.
 */
const readLogicalLines: (rawLines: readonly string[]) => VisualBasicLine[] = (rawLines: readonly string[]): VisualBasicLine[] => {
    const logical: VisualBasicLine[] = [];
    let index: number = 0;
    while (index < rawLines.length) {
        const startLine: number = index + 1;
        const first: VisualBasicMasked = maskLine(rawLines[index]);
        let code: string = first.code;
        let masked: string = first.masked;
        let endLine: number = startLine;
        while (isContinuation(code)) {
            index += 1;
            if (index >= rawLines.length) {
                break;
            }
            const next: VisualBasicMasked = maskLine(rawLines[index]);
            code = `${trimContinuation(code)} ${next.code}`;
            masked = `${trimContinuation(masked)} ${next.masked}`;
            endLine = index + 1;
        }
        logical.push({ code, masked, startLine, endLine });
        index += 1;
    }
    return logical;
};

/**
 * Whether a line carries code once leading attributes are removed. Attribute-only
 * and comment-only lines are not significant: they neither declare a node nor
 * count as the next line of a property body.
 */
const isSignificant: (masked: string) => boolean = (masked: string): boolean => masked.replace(AttributePrefixPattern, "").trim().length > 0;

/**
 * Strip a leading attribute list, the modifier chain and at most one `Dim`/
 * `Const` word from a masked line. Modifiers come back lowercase in source
 * order; the remaining text starts at the declaration keyword.
 */
const readHeader: (masked: string) => VisualBasicHeader = (masked: string): VisualBasicHeader => {
    let rest: string = masked.replace(AttributePrefixPattern, "").trim();
    const modifiers: string[] = [];
    for (;;) {
        const match: RegExpExecArray | null = WordPattern.exec(rest);
        if (match === null) {
            break;
        }
        const word: string = match[1].toLowerCase();
        if (!VisualBasicKeywords.isModifier(word)) {
            break;
        }
        modifiers.push(word);
        rest = rest.slice(match[0].length).trim();
    }
    const keyword: RegExpExecArray | null = WordPattern.exec(rest);
    if (keyword !== null && VisualBasicKeywords.isVariableKeyword(keyword[1].toLowerCase())) {
        rest = rest.slice(keyword[0].length).trim();
    }
    return { modifiers, rest };
};

/**
 * Strip the brackets of an escaped identifier so the label reads as the name.
 */
const normalizeIdentifier: (raw: string) => string = (raw: string): string =>
    raw.startsWith("[") && raw.endsWith("]") ? raw.slice(1, -1).trim() : raw;

/**
 * Split a field declaration body on the commas that separate declarators.
 * A comma inside parentheses (an initializer, `New List(Of String)`), braces (an
 * array literal) or brackets does not separate declarators.
 */
const splitDeclarators: (body: string) => string[] = (body: string): string[] => {
    const parts: string[] = [];
    let depth: number = 0;
    let start: number = 0;
    for (let index: number = 0; index < body.length; index += 1) {
        const character: string = body[index];
        if (character === "(" || character === "{" || character === "[") {
            depth += 1;
            continue;
        }
        if (character === ")" || character === "}" || character === "]") {
            depth = Math.max(0, depth - 1);
            continue;
        }
        if (character === "," && depth === 0) {
            parts.push(body.slice(start, index));
            start = index + 1;
        }
    }
    parts.push(body.slice(start));
    return parts;
};

/**
 * Whether the next significant line starts a property accessor. VB requires the
 * accessor to be the first statement of a full property, so one line of
 * lookahead separates it from an auto-implemented property.
 */
const startsAccessor: (lines: readonly VisualBasicLine[], nextCode: readonly number[], index: number) => boolean = (
    lines: readonly VisualBasicLine[], nextCode: readonly number[], index: number,
): boolean => {
    const next: number = nextCode[index];
    if (next === -1) {
        return false;
    }
    return AccessorPattern.test(readHeader(lines[next].masked).rest);
};

/**
 * End keyword of an anonymous multi-line lambda opened on one line, or
 * `undefined` when the line holds no lambda or closes it on the same line.
 *
 * The parameter list and an optional `As <type>` return clause are the whole
 * tail of a multi-line lambda header; anything else means the body starts on
 * the same line and no `End` frame is needed.
 */
const lambdaEndKeyword: (masked: string) => string | undefined = (masked: string): string | undefined => {
    const open: RegExpExecArray | null = LambdaOpenerPattern.exec(masked);
    if (open === null) {
        return undefined;
    }
    let depth: number = 0;
    let close: number = -1;
    for (let index: number = open.index + open[0].length - 1; index < masked.length; index += 1) {
        const character: string = masked[index];
        if (character === "(") {
            depth += 1;
            continue;
        }
        if (character === ")") {
            depth -= 1;
            if (depth === 0) {
                close = index;
                break;
            }
        }
    }
    if (close === -1) {
        return undefined;
    }
    const rest: string = masked.slice(close + 1).trim();
    if (rest.length === 0 || /^as\s+/i.test(rest)) {
        return open[1].toLowerCase();
    }
    return undefined;
};

/**
 * Whether a `Sub`/`Function` line opens a body. An interface signature and a
 * `MustOverride` declaration have no `End Sub`/`End Function` line; a `Declare`
 * statement is handled by its own pattern.
 */
const declarationHasBody: (frames: readonly VisualBasicFrame[], modifiers: readonly string[]) => boolean = (
    frames: readonly VisualBasicFrame[], modifiers: readonly string[],
): boolean => {
    if (frames.length > 0 && frames[frames.length - 1].node?.kind === "interface") {
        return false;
    }
    return !modifiers.includes("mustoverride");
};

/**
 * Nearest open block that owns members.
 */
const innermostContainer: (frames: readonly VisualBasicFrame[]) => VisualBasicDraft | undefined = (
    frames: readonly VisualBasicFrame[],
): VisualBasicDraft | undefined => {
    for (let index: number = frames.length - 1; index >= 0; index -= 1) {
        const node: VisualBasicDraft | undefined = frames[index].node;
        if (frames[index].container && node !== (void 0)) {
            return node;
        }
    }
    return undefined;
};

/**
 * Number of open containers, which is exactly the depth a declaration reports.
 */
const containerDepth: (frames: readonly VisualBasicFrame[]) => number = (frames: readonly VisualBasicFrame[]): number => {
    let count: number = 0;
    for (let index: number = 0; index < frames.length; index += 1) {
        if (frames[index].container) {
            count += 1;
        }
    }
    return count;
};

/**
 * Build one draft node; `endLine` is the last physical line of the declaration
 * (a continued signature spans several) and is patched when a block closes.
 */
const createDraft: (label: string, kind: OutlineKind, startLine: number, endLine: number, depth: number, detail: string, modifiers: readonly string[]) => VisualBasicDraft = (
    label: string, kind: OutlineKind, startLine: number, endLine: number, depth: number, detail: string, modifiers: readonly string[],
): VisualBasicDraft => ({ label, kind, startLine, endLine, depth, detail, modifiers: [...modifiers], children: [] });

/**
 * Attach one draft to its enclosing container, or to the file root.
 */
const attachDraft: (roots: VisualBasicDraft[], parent: VisualBasicDraft | undefined, node: VisualBasicDraft) => void = (
    roots: VisualBasicDraft[], parent: VisualBasicDraft | undefined, node: VisualBasicDraft,
): void => {
    if (parent === (void 0)) {
        roots.push(node);
    } else {
        parent.children.push(node);
    }
};

/**
 * Pop the innermost frame that an `End <keyword>` line closes. A frame still
 * open above it ends on the previous line, so a malformed file still yields
 * contained ranges. A keyword no frame carries (`End If`, `End While`, ...) is
 * ignored, and a lambda frame carries no node to patch.
 */
const closeBlock: (frames: VisualBasicFrame[], keyword: string, line: number) => void = (
    frames: VisualBasicFrame[], keyword: string, line: number,
): void => {
    for (let index: number = frames.length - 1; index >= 0; index -= 1) {
        if (frames[index].end !== keyword) {
            continue;
        }
        for (let above: number = frames.length - 1; above > index; above -= 1) {
            const node: VisualBasicDraft | undefined = frames[above].node;
            if (node !== (void 0)) {
                node.endLine = Math.max(node.startLine, line - 1);
            }
        }
        const node: VisualBasicDraft | undefined = frames[index].node;
        if (node !== (void 0)) {
            node.endLine = Math.max(node.startLine, line);
        }
        frames.length = index;
        return;
    }
};

/**
 * Convert a draft tree into the public node shape.
 *
 * Byte offsets stay at zero because a strategy only owns line numbers: the
 * registry resolves the anchor and the authoritative UTF-8 byte range from
 * `ByteLineIndex`. The empty `path` is likewise filled by the registry.
 */
const finalizeDraft: (draft: VisualBasicDraft) => OutlineNode = (draft: VisualBasicDraft): OutlineNode => {
    const startLine: number = Math.max(1, draft.startLine);
    const endLine: number = Math.max(startLine, draft.endLine);
    return {
        isFile: false,
        isDirectory: false,
        path: "",
        type: draft.kind,
        range: { startByte: 0n, endByte: 0n, startLine: BigInt(startLine), endLine: BigInt(endLine) },
        label: draft.label,
        depth: Math.max(0, draft.depth),
        ...(draft.modifiers.length === 0 ? {} : { modifiers: [...draft.modifiers] }),
        ...(draft.detail.length === 0 ? {} : { detail: draft.detail }),
        children: draft.children.map(finalizeDraft),
    };
};

/**
 * Parse Visual Basic source text.
 *
 * The walk is single pass with an `End` stack. Blocks come from the source's own
 * delimiters: `Namespace`, `Class`, `Module`, `Structure`, `Interface` and
 * `Enum` open containers, `Sub`/`Function`/`Property` open bodies, and the
 * matching `End` line gives the node's `endLine`. Members attach to the nearest
 * open container, not to the nearest open body, so a property or method body
 * never becomes a parent of the next member.
 *
 * @param input - Decoded VB text and its line index (the index is not needed by
 * this line-based scanner, but the input contract requires it); `input.path`
 * also decides whether untyped VBScript fields are accepted.
 * @returns Namespace/type/member tree; an empty list for an empty file.
 */
export const parseVisualBasic: (input: OutlineParseInput) => OutlineNode[] = (input: OutlineParseInput): OutlineNode[] => {
    const text: string = input.text.charCodeAt(0) === 0xfeff ? input.text.slice(1) : input.text;
    const rawLines: string[] = splitSourceLines(text);
    const total: number = rawLines.length;
    if (total === 0) {
        return [];
    }
    const lines: VisualBasicLine[] = readLogicalLines(rawLines);
    const scriptMode: boolean = hasExtension(baseNameOf(input.path), [".vbs"]);
    const nextCode: number[] = new Array<number>(lines.length).fill(-1);
    let upcoming: number = -1;
    for (let index: number = lines.length - 1; index >= 0; index -= 1) {
        nextCode[index] = upcoming;
        if (isSignificant(lines[index].masked)) {
            upcoming = index;
        }
    }
    const roots: VisualBasicDraft[] = [];
    const frames: VisualBasicFrame[] = [];
    for (let index: number = 0; index < lines.length; index += 1) {
        const line: VisualBasicLine = lines[index];
        const startLine: number = line.startLine;
        const stripped: string = line.masked.replace(AttributePrefixPattern, "").trim();
        if (stripped.length === 0) {
            continue;
        }
        const code: string = line.code.trim();
        const endMatch: RegExpExecArray | null = EndBlockPattern.exec(stripped);
        if (endMatch !== null) {
            closeBlock(frames, endMatch[1].toLowerCase(), startLine);
            continue;
        }
        const header: VisualBasicHeader = readHeader(stripped);
        if (header.rest.length === 0) {
            continue;
        }
        const modifiers: readonly string[] = header.modifiers;
        const parent: VisualBasicDraft | undefined = innermostContainer(frames);
        const depth: number = containerDepth(frames);
        const namespaceMatch: RegExpExecArray | null = NamespacePattern.exec(header.rest);
        if (namespaceMatch !== null) {
            const node: VisualBasicDraft = createDraft(namespaceMatch[1], "namespace", startLine, line.endLine, depth, code, modifiers);
            attachDraft(roots, parent, node);
            frames.push({ end: "namespace", container: true, node });
            continue;
        }
        const blockMatch: RegExpExecArray | null = BlockPattern.exec(header.rest);
        if (blockMatch !== null) {
            const keyword: string = blockMatch[1].toLowerCase();
            const kind: OutlineKind = VisualBasicBlockKinds.get(keyword) ?? "class";
            const node: VisualBasicDraft = createDraft(normalizeIdentifier(blockMatch[2]), kind, startLine, line.endLine, depth, code, modifiers);
            attachDraft(roots, parent, node);
            frames.push({ end: keyword, container: true, node });
            continue;
        }
        const insideEnum: boolean = frames.length > 0 && frames[frames.length - 1].node?.kind === "enum";
        if (insideEnum) {
            const memberMatch: RegExpExecArray | null = EnumMemberPattern.exec(header.rest);
            if (memberMatch !== null) {
                const label: string = normalizeIdentifier(memberMatch[1]);
                if (label.length > 0) {
                    attachDraft(roots, parent, createDraft(label, "constant", startLine, line.endLine, depth, code, modifiers));
                }
            }
            continue;
        }
        const declareMatch: RegExpExecArray | null = DeclarePattern.exec(header.rest);
        if (declareMatch !== null) {
            const kind: OutlineKind = declareMatch[1].toLowerCase() === "sub" ? "method" : "function";
            attachDraft(roots, parent, createDraft(normalizeIdentifier(declareMatch[2]), kind, startLine, line.endLine, depth, code, modifiers));
            continue;
        }
        const methodMatch: RegExpExecArray | null = MethodPattern.exec(header.rest);
        if (methodMatch !== null) {
            const keyword: string = methodMatch[1].toLowerCase();
            const kind: OutlineKind = keyword === "sub" ? "method" : "function";
            const node: VisualBasicDraft = createDraft(normalizeIdentifier(methodMatch[2]), kind, startLine, line.endLine, depth, code, modifiers);
            attachDraft(roots, parent, node);
            if (declarationHasBody(frames, modifiers)) {
                frames.push({ end: keyword, container: false, node });
            }
            continue;
        }
        const propertyMatch: RegExpExecArray | null = PropertyPattern.exec(header.rest);
        if (propertyMatch !== null) {
            const accessor: string = (propertyMatch[1] ?? "").toLowerCase();
            const node: VisualBasicDraft = createDraft(normalizeIdentifier(propertyMatch[2]), "property", startLine, line.endLine, depth, code, modifiers);
            attachDraft(roots, parent, node);
            if (accessor.length > 0 || startsAccessor(lines, nextCode, index)) {
                frames.push({ end: "property", container: false, node });
            }
            continue;
        }
        const delegateMatch: RegExpExecArray | null = DelegatePattern.exec(header.rest);
        if (delegateMatch !== null) {
            attachDraft(
                roots,
                parent,
                createDraft(normalizeIdentifier(delegateMatch[2]), "type", startLine, line.endLine, depth, code, modifiers),
            );
            continue;
        }
        const eventMatch: RegExpExecArray | null = EventPattern.exec(header.rest);
        if (eventMatch !== null) {
            const node: VisualBasicDraft = createDraft(normalizeIdentifier(eventMatch[1]), "property", startLine, line.endLine, depth, code, modifiers);
            attachDraft(roots, parent, node);
            if (modifiers.includes("custom")) {
                frames.push({ end: "event", container: false, node });
            }
            continue;
        }
        const operatorMatch: RegExpExecArray | null = OperatorPattern.exec(header.rest);
        if (operatorMatch !== null) {
            const node: VisualBasicDraft = createDraft(
                `Operator ${operatorMatch[1]}`,
                "method",
                startLine,
                line.endLine,
                depth,
                code,
                modifiers,
            );
            attachDraft(roots, parent, node);
            frames.push({ end: "operator", container: false, node });
            continue;
        }
        const innermost: VisualBasicFrame | undefined = frames.length === 0 ? undefined : frames[frames.length - 1];
        const owner: VisualBasicDraft | undefined = innermost !== (void 0) && innermost.container ? innermost.node : undefined;
        if (owner !== (void 0) && VisualBasicMemberOwners.has(owner.kind)) {
            const declarators: string[] = splitDeclarators(header.rest);
            for (let declaratorIndex: number = 0; declaratorIndex < declarators.length; declaratorIndex += 1) {
                const declarator: string = declarators[declaratorIndex].trim();
                if (declarator.length === 0) {
                    continue;
                }
                const fieldMatch: RegExpExecArray | null = FieldPattern.exec(declarator);
                const untypedMatch: RegExpExecArray | null = fieldMatch === null && scriptMode ? UntypedFieldPattern.exec(declarator) : null;
                const matched: RegExpExecArray | null = fieldMatch ?? untypedMatch;
                if (matched === null) {
                    continue;
                }
                const label: string = normalizeIdentifier(matched[1]);
                if (label.length === 0) {
                    continue;
                }
                owner.children.push(createDraft(label, "property", startLine, line.endLine, depth, code, modifiers));
            }
        }
        const lambdaEnd: string | undefined = lambdaEndKeyword(stripped);
        if (lambdaEnd !== (void 0)) {
            frames.push({ end: lambdaEnd, container: false });
        }
    }
    for (let index: number = frames.length - 1; index >= 0; index -= 1) {
        const node: VisualBasicDraft | undefined = frames[index].node;
        if (node !== (void 0)) {
            node.endLine = Math.max(node.startLine, total);
        }
    }
    return roots.map(finalizeDraft);
};

/**
 * Registry adapter for the VB parser.
 *
 * `id` is the stable strategy tag written to `OutlineResult.strategy` (camelCase
 * like `plainText`); `language` is the stable lowercase tag written to
 * `OutlineResult.language`. Both `.vb` and `.vbs` select this strategy, and
 * `.vbproj` deliberately does not, so the XML project strategy keeps that file.
 */
export const VisualBasicStrategy: OutlineStrategy = {
    id: "visualBasic",
    category: "code",
    language: "visualbasic",
    matches: (input: OutlineMatchInput): boolean => hasExtension(baseNameOf(input.name), VisualBasicExtensions),
    parse: parseVisualBasic,
};
