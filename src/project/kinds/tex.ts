import type { ProjectKindDefinition } from "./types.ts";

export const definition: ProjectKindDefinition = Object.freeze({
    id: "tex",
    displayName: "TeX",
    language: "tex",
    markers: Object.freeze([
        Object.freeze({ path: ".tex", match: "suffix" as const, weight: 2, label: "TeX source document" }),
        Object.freeze({ path: "latexmkrc", match: "exact" as const, weight: 1, label: "latexmk configuration" }),
        Object.freeze({ path: ".latexmkrc", match: "exact" as const, weight: 1, label: "latexmk user configuration" }),
        Object.freeze({ path: ".bib", match: "suffix" as const, weight: 1, label: "BibTeX bibliography" }),
    ]),
    environment: Object.freeze({
        variables: Object.freeze({ TEXINPUTS: ".:./styles//:" }),
        paths: Object.freeze(["sections", "figures", "styles", "build"]),
        dependencies: Object.freeze([
            Object.freeze({ id: "latexmk", scope: "build" as const, manager: "tlmgr" }),
            Object.freeze({ id: "bibtex", scope: "build" as const, optional: true }),
        ]),
    }),
    priority: 40,
});
