/** Host-loaded environment descriptions and metadata. */
export { EnvironmentCategories, EnvironmentAvailabilities } from "./types.ts";
export type { EnvironmentCategory, EnvironmentAvailability, EnvironmentMetadata } from "./types.ts";
export { getDefaultEnvironments, loadDefaultEnvironments } from "./catalog.ts";
export type { EnvironmentEntry } from "./catalog.ts";
