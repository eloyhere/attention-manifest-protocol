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
export type { ContextIndexOptions, ContextIndexStats } from "./contextIndex.ts";
export { agentContextToAst, windowToAst } from "./projections.ts";
export type { AgentContextProjection } from "./projections.ts";
export { Context } from "./lifecycle.ts";
export type { ContextOptions, ContextPhase, ContextSnapshot, ContextView } from "./lifecycle.ts";
export { WorkspaceIndex, workspaceTerms } from "./workspace.ts";
export { WorkspaceAgentService } from "./workspaceService.ts";
export type { WorkspaceServiceLimits, WorkspaceServiceOptions } from "./workspaceService.ts";
export { WorkspaceProtocol, WorkspaceProtocolVersion, workspaceToolDefinitions } from "./workspaceProtocol.ts";
export type { WorkspaceErrorCode, WorkspaceResponse, WorkspaceToolDefinition } from "./workspaceProtocol.ts";
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
