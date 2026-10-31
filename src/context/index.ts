export { assembleContext } from "./context.ts";
export type { ContextAssembly, ContextSegment } from "./context.ts";
export { assembleAgentContext, estimateTokens } from "./agentContext.ts";
export type { AgentContext, AgentContextAssembler, AgentContextKind, AgentContextOptions, AgentContextSegment, ExcludedSegment } from "./agentContext.ts";
export { ContextAst, FileDetailStore, MemoryDetailStore } from "./ast.ts";
export type { ContextAstEdge, ContextAstNode, ContextAstView, ContextEdgeKind, ContextNodeKind, ContextOmission, DetailStore } from "./ast.ts";
export { FileContentStore, MemoryContentStore } from "./contentStore.ts";
export type { ContentStore } from "./contentStore.ts";
export { encodeDocumentDetail, readDocumentDetail } from "./document.ts";
export type {
    DocumentCell,
    DocumentDetail,
    DocumentEnvelope,
    DocumentLocator,
    DocumentSourceRevision,
    SlideObject,
    SummaryProvenance,
    TexDependency,
    TexProjectDetail,
} from "./document.ts";
export { ContextIndex } from "./contextIndex.ts";
export {
    ContextBuilderError,
    ContextSummaryLimit,
    clampSummary,
    freezeContextPackage,
    renderContextItem,
    renderContextPackageText,
    renderContextRelation,
    toContextRange,
} from "./contextPackage.ts";
export type {
    ContextBuilderErrorCode,
    ContextItem,
    ContextItemKind,
    ContextOmission as ContextPackageOmission,
    ContextOmissionReason,
    ContextPackage,
    ContextProvenance,
    ContextRange,
    ContextRelation,
    ContextRelationKind,
} from "./contextPackage.ts";
export { ContextBuilder } from "./contextBuilder.ts";
export type {
    AddDependencyOptions,
    AddFileOptions,
    AddImportsOptions,
    AddOutlineOptions,
    ContextBuilderOptions,
    ContextBuilderSession,
    ImportDirection,
} from "./contextBuilder.ts";
export { DefaultContextWeights, PathPrefixIndex, compareScoredDrafts, draftContextItem, draftTokens, provenanceRank, resolveContextWeights, scoreDraft } from "./relevance.ts";
export type { ContextItemDraft, ContextWeights, ScoredDraft } from "./relevance.ts";
export type { ContextIndexOptions, ContextIndexStats } from "./contextIndex.ts";
export { agentContextToAst, windowToAst } from "./projections.ts";
export type { AgentContextProjection } from "./projections.ts";
export { Context } from "./lifecycle.ts";
export type { ContextOptions, ContextPhase, ContextSnapshot, ContextView } from "./lifecycle.ts";
export { WorkspaceIndex, workspaceTerms } from "./workspace.ts";
export { WorkspaceAgentService } from "./workspaceService.ts";
export { WorkspaceDiffError, applyByteChanges, applyLineChanges, summarizeDiff } from "./workspaceDiff.ts";
export type { ByteChange, DiffHunkSummary, DiffSummary, LineChange, WorkspaceDiffCode } from "./workspaceDiff.ts";
export type {
    WorkspaceRunOutcome,
    WorkspaceRunRequest,
    WorkspaceRunner,
    WorkspaceServiceLimits,
    WorkspaceServiceOptions,
    WorkspaceWriteOutcome,
    WorkspaceWriteRequest,
    WorkspaceWriter,
} from "./workspaceService.ts";
/**
 * The workspace protocol surface moved to `src/protocol`; this re-export keeps
 * the documented root entry stable for existing importers.
 */
export * from "../protocol/workspace.ts";
export type {
    WorkspaceCandidate,
    WorkspaceDiagnostic,
    WorkspaceEntity,
    WorkspaceEntityKind,
    WorkspaceQuery,
    WorkspaceQueryResult,
    WorkspaceRelation,
    WorkspaceRelationKind,
    WorkspaceSnapshot,
    WorkspaceSource,
} from "./workspace.ts";
