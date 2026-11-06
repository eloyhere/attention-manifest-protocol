import { SynchronousUnorderedSet } from "semantic-typescript";
import type { PermissionScope, Profession } from "./types.ts";

export function restrictByProfession(scope: PermissionScope, profession: Profession): PermissionScope {
    const allowed = new SynchronousUnorderedSet(profession.allowedCapabilityIds);
    const denied = new SynchronousUnorderedSet(profession.deniedCapabilityIds);
    return { capabilityIds: Object.freeze(scope.capabilityIds.filter(id => allowed.contains(id) && !denied.contains(id))), operations: Object.freeze([...scope.operations]), resources: Object.freeze([...scope.resources]), allowWrite: scope.allowWrite };
}

export function intersectPermissionScopes(parent: PermissionScope, requested: PermissionScope): PermissionScope {
    const allowed = new SynchronousUnorderedSet(requested.capabilityIds);
    const operations = new SynchronousUnorderedSet(requested.operations);
    const resources = new SynchronousUnorderedSet(requested.resources);
    return { capabilityIds: Object.freeze(parent.capabilityIds.filter(item => allowed.contains(item))), operations: Object.freeze(parent.operations.filter(item => operations.contains(item))), resources: Object.freeze(parent.resources.filter(item => resources.contains(item))), allowWrite: parent.allowWrite && requested.allowWrite };
}
