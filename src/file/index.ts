/**
 * Public filesystem surface: tree nodes, reads/writes, outlines and module
 * graphs. Every export is read-only except `writeFile`/`ensureDirectory`;
 * mutation authority is granted by a `SessionRoot` and enforced by
 * `PathSandbox`.
 */
export * from "./types.ts";
export { FilesystemError, fail, isFilesystemError } from "./errors.ts";
export { detectCharset, decodeText, encodeText, countLines, LineIndex } from "../syntax/charset.ts";
export type { DetectedCharset } from "../syntax/charset.ts";
export { ByteLineIndex } from "../syntax/byteIndex.ts";
export { formatNodeTime, formatIsoTime, parseNodeTime, creationTime } from "./time.ts";
export { PathSandbox } from "./path.ts";
export type { PathSandboxOptions } from "./path.ts";
export { buildFileNode, wireNode, wireTree, verifyFingerprint } from "./file.ts";
export { buildDirectoryNode, listDirectory, compareTreeNodes } from "./directory.ts";
export { buildTree, WorkspaceTree } from "./tree.ts";
export { readPage, ReadCache, byteRangeFingerprint, locateLineSpan, useByte as useByteRead, useLine as useLineRead } from "./read.ts";
export type { ReadOptions, ByteUse, ByteUseRequest, LineEnding, LineSpan, LineUse, LineUseRequest } from "./read.ts";
export { writeFile, ensureDirectory, WriteLocks, useByte as useByteWrite, useLine as useLineWrite } from "./write.ts";
export type {
    BytePatchRequest,
    LinePatchRequest,
    PatchJournalEntry,
    WriteOptions,
    WritePatchOptions,
    WritePatchResult,
} from "./write.ts";
export { SessionRuntime } from "./runtime.ts";
export type { AnnotationMap, ResolvedNode, SessionRuntimeOptions } from "./runtime.ts";
export { FilesystemService, FilesystemSession, filesystemSessionSummary } from "./service.ts";
export type {
    AstRequest,
    DependencyQuery,
    ExportRequest,
    FilesystemServiceLimits,
    FilesystemServiceOptions,
    ImportRequest,
    OutlineRequest,
} from "./service.ts";
export {
    buildOutline,
    OutlineRegistry,
    DefaultOutlineRegistry,
    OutlineStrategies,
    OutlineMaxFileBytes,
    OutlineMaxScanLines,
    OutlineDefaultMaxNodes,
    OutlineHardMaxNodes,
    OutlineDefaultMaxDepth,
    OutlineHardMaxDepth,
    createOutlineRegistry,
    outlineLanguage,
    outlineNodeFingerprint,
} from "../outline/outline.ts";
export type { FingerprintedOutlineNode, OutlineAnchor, OutlineMatchInput, OutlineOptions, OutlineParseInput, OutlineStrategy } from "../outline/outline.ts";
export { DefaultOutlineKeywords, OutlineKeywordRegistry, createOutlineKeywordRegistry } from "../outline/outlineKeywords.ts";
export type { OutlineKeywordCategory } from "../outline/outlineKeywords.ts";
export { buildSyntaxTree } from "./syntaxTree.ts";
export {
    DefaultSyntaxRegistry,
    SyntaxRegistry,
    buildSyntaxTreeFromText,
    createSyntaxRegistry,
    disposeSyntaxNode,
    syntaxLanguageOf,
    wireSyntaxTree,
} from "../syntax/syntaxTree.ts";
export type {
    SyntaxLanguage,
    SyntaxLanguageDefinition,
    SyntaxNode,
    SyntaxNodeKind,
    SyntaxNodeKindDefinition,
    SyntaxToken,
    SyntaxTokenKind,
    SyntaxTokenKindDefinition,
    SyntaxTree,
    SyntaxTreeOptions,
    WireSyntaxNode,
    WireSyntaxToken,
    WireSyntaxTree,
} from "../syntax/syntaxTree.ts";
export { OutlineIndex, buildOutlineIndex, filterOutline, hasLabelPrefix, wireOutline, wireOutlineNode, wireOutlineRange, outlineFromWire } from "../outline/outlineIndex.ts";
export type { OutlinePayload } from "../outline/outlineIndex.ts";
export { extractImports, importedBy, isParseableSource, readSourceFile, resolveImportSpecifier, tokenizeSource } from "./importGraph.ts";
export type { ResolvedSpecifier, SourceFileSnapshot, SourceToken } from "./importGraph.ts";
export { extractExports } from "./exportGraph.ts";
export { DependencyGraph, buildDependencyReport, graphFromImports } from "./dependency.ts";
export { isOfficeFile, parseOffice, officeImports, officeExports, officeReferences, officeOutlineParser, installOfficeOutlineParser } from "../outline/office.ts";
export type { OfficeDocument, OfficeFormat, OfficeKind, OfficeReference, OfficeSection, OfficeSectionKind } from "../outline/office.ts";
export { readCfb } from "./cfb.ts";
export type { CfbEntry } from "./cfb.ts";
export { readZipEntries, zipText } from "./zip.ts";
export type { ZipEntry } from "./zip.ts";
export type { DependencyClosure, DependencyRequest, DependencySubgraph, TopologicalResult } from "./dependency.ts";
