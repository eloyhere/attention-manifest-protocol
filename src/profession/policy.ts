import { SynchronousUnorderedSet } from "semantic-typescript";
import type { PermissionScope, Profession, ProfessionProfile } from "./types.ts";

const isLegacyProfession = (value: Profession | ProfessionProfile): value is Profession => "allowedCapabilityIds" in value;

const restrictLegacy = (scope: PermissionScope, profession: Profession): PermissionScope => {
    const allowed = new SynchronousUnorderedSet(profession.allowedCapabilityIds);
    const denied = new SynchronousUnorderedSet(profession.deniedCapabilityIds);
    return { capabilityIds: Object.freeze(scope.capabilityIds.filter(id => allowed.contains(id) && !denied.contains(id))), operations: Object.freeze([...scope.operations]), resources: Object.freeze([...scope.resources]), allowWrite: scope.allowWrite };
};

const restrictProfile = (scope: PermissionScope, profile: ProfessionProfile): PermissionScope => {
    const allowed = new SynchronousUnorderedSet(profile.permissionScope.capabilityIds);
    const denied = new SynchronousUnorderedSet(profile.deniedCapabilityIds);
    const operations = new SynchronousUnorderedSet(profile.permissionScope.operations);
    const resources = new SynchronousUnorderedSet(profile.permissionScope.resources);
    return {
        capabilityIds: Object.freeze(scope.capabilityIds.filter(id => allowed.contains(id) && !denied.contains(id))),
        operations: Object.freeze(scope.operations.filter(operation => operations.contains(operation))),
        resources: Object.freeze(scope.resources.filter(resource => resources.contains(resource))),
        allowWrite: scope.allowWrite && profile.permissionScope.allowWrite,
    };
};

/**
 * Narrows a permission scope by a legacy `Profession` or a `ProfessionProfile`.
 * Composition is intersection-only: a profession can never grant authority.
 * Profiles additionally compose operations, resources and write permission.
 */
export function restrictByProfession(scope: PermissionScope, profession: Profession | ProfessionProfile): PermissionScope {
    return isLegacyProfession(profession) ? restrictLegacy(scope, profession) : restrictProfile(scope, profession);
}

/** Folds several profession restrictions left-to-right, always narrowing. */
export function composeProfessionRestrictions(scope: PermissionScope, professions: readonly (Profession | ProfessionProfile)[]): PermissionScope {
    return professions.reduce((current, profession) => restrictByProfession(current, profession), scope);
}

export function intersectPermissionScopes(parent: PermissionScope, requested: PermissionScope): PermissionScope {
    const allowed = new SynchronousUnorderedSet(requested.capabilityIds);
    const operations = new SynchronousUnorderedSet(requested.operations);
    const resources = new SynchronousUnorderedSet(requested.resources);
    return { capabilityIds: Object.freeze(parent.capabilityIds.filter(item => allowed.contains(item))), operations: Object.freeze(parent.operations.filter(item => operations.contains(item))), resources: Object.freeze(parent.resources.filter(item => resources.contains(item))), allowWrite: parent.allowWrite && requested.allowWrite };
}
