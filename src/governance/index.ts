/**
 * The attention-governance layer: nine constructs from the protocol
 * description, all pure TypeScript and independent of SQLite.
 *
 *   matrix        scenario x interaction-mode tables (9.1-9.8)
 *   perspectives  the perspective registry and activation rules
 *   attentionManifest  derive, issue, load, reassess, update, expire
 *   context       global core, private context, receipt blackboard
 *   credential    triple-signed switch credentials
 *   control       Bayesian routing of attention, not generation
 *   legal         behaviour codes, gates, freeze, downgrade, breaker
 *   budget        global, perspective and escalation-reserve ledgers
 *   workflow      seven phases with approval gates
 */
export * from "./types.ts";
export * from "./matrix.ts";
export * from "./perspectives.ts";
export * from "./attentionManifest.ts";
export * from "./context.ts";
export * from "./credential.ts";
export * from "./control.ts";
export * from "./legal.ts";
export * from "./budget.ts";
export * from "./cooperation.ts";
export * from "./transport.ts";
export * from "./httpServer.ts";
export * from "./switching.ts";
export * from "./audit.ts";
export * from "./store.ts";
export * from "./signing.ts";
export * from "./toolPolicy.ts";
export * from "./workflow.ts";
