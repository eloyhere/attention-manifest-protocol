import { LanguageRegistry } from "./registry.ts";
import type { LanguageDefinition } from "./types.ts";
import { definition as markdown } from "./markdown.ts";
import { definition as text } from "./text.ts";
import { definition as tex } from "./tex.ts";
import { definition as javascript } from "./javascript.ts";
import { definition as typescript } from "./typescript.ts";
import { definition as c } from "./c.ts";
import { definition as cpp } from "./cpp.ts";
import { definition as java } from "./java.ts";
import { definition as python } from "./python.ts";
import { definition as csharp } from "./csharp.ts";
import { definition as mysql } from "./mysql.ts";
import { definition as oracle } from "./oracle.ts";
import { definition as sqlserver } from "./sqlserver.ts";
import { definition as word } from "./word.ts";
import { definition as excel } from "./excel.ts";
import { definition as powerPoint } from "./powerPoint.ts";
import { definition as access } from "./access.ts";
import { definition as publisher } from "./publisher.ts";
import { definition as html } from "./html.ts";
import { definition as vue } from "./vue.ts";
import { definition as css } from "./css.ts";
import { definition as scss } from "./scss.ts";
import { definition as sass } from "./sass.ts";
import { definition as swift } from "./swift.ts";
import { definition as go } from "./go.ts";
import { definition as xml } from "./xml.ts";
import { definition as max3d } from "./max3d.ts";
import { definition as solidworks } from "./solidworks.ts";
import { definition as photoshop } from "./photoshop.ts";
import { definition as cad } from "./cad.ts";
import { definition as json } from "./json.ts";
import { definition as compress } from "./compress.ts";

/** A fresh registry avoids mutating a process-wide language singleton. No unknown-file fallback. */
export function createDefaultLanguageRegistry(): LanguageRegistry {
    return new LanguageRegistry({ definitions: builtinLanguages });
}
export const builtinLanguages: readonly LanguageDefinition[] = Object.freeze([
    markdown, text, tex, javascript, typescript, c, cpp, java, python, csharp, mysql, oracle, sqlserver,
    word, excel, powerPoint, access, publisher, max3d, solidworks, photoshop, cad,
    html, vue, css, scss, sass, swift, go, xml, json, compress,
].map(value => Object.freeze({ ...value, extensions: Object.freeze([...value.extensions]), mimeTypes: Object.freeze([...value.mimeTypes]) })));
