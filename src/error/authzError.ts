/**
 * Authorization errors: a denied capability, or a grant that would amplify
 * rights or lifetime. They share the `AmpError` shape so the kernel can turn
 * any of them into a blocked receipt.
 */
import { AmpError } from "./ampError.ts";

export type AuthzCode = "permission_denied" | "invalid_grant" | "rights_amplification" | "expiry_amplification" | "unknown_capability";

export class AuthzError extends AmpError<AuthzCode> {
    constructor(code: AuthzCode, problems: readonly string[]) {
        super("AuthzError", code, problems);
    }
}
