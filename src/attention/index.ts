export type * from "./types.ts";
export { AttentionError } from "./validation.ts";
export { createAttention, focus, blur, mount, unmount, persist, update, verify } from "./operations.ts";
export { associate } from "./associate.ts";
/** Compatibility exports; the context domain owns compilation. */
export { attentionPriority, compileContext } from "../context/compiler.ts";
