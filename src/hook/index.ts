/**
 * Public surface of the hook layer.
 *
 * The concrete `use*` hooks and their shared types are exported here. Each
 * module has its own `useParse` read helper, so those collide by design; they
 * are re-exported under module-qualified names (`useCodeParse`,
 * `useProjectParse`, ...) and the original name remains available from the
 * module itself.
 *
 * `createHook` is re-exported explicitly because it is the extension point a
 * host uses to add a hook without changing this package.
 */
export * from "./types.ts";
export * from "./diff.ts";
export * from "./file.ts";
export { createHook } from "./types.ts";
export type { DependencyFacts, DependencyParse } from "./dependency.ts";
export { useDependency, useParse as useDependencyParse } from "./dependency.ts";
export type { ExportationParse } from "./exportation.ts";
export { useExportation, useParse as useExportationParse } from "./exportation.ts";
export type { ImportationParse } from "./importation.ts";
export { useImportation, useParse as useImportationParse } from "./importation.ts";
export type { OutlineParse } from "./outline.ts";
export { useOutline, useParse as useOutlineParse } from "./outline.ts";
export type { AstParse } from "./ast.ts";
export { useAst, useParse as useAstParse } from "./ast.ts";
export type { CodeModel, CodeParse, CodeRequest } from "./code.ts";
export { useCode, useParse as useCodeParse } from "./code.ts";
export type { ProjectKind, ProjectModel, ProjectParse, ProjectRequest } from "./project.ts";
export { projectKindOf, useProject, useParse as useProjectParse } from "./project.ts";
