export type { EntityCacheOptions, CacheStats, EntityCache } from "./types.ts";
export { createEntityCache } from "./entityCache.ts";
export type { CachingProxyOptions, CacheProxyHandle } from "./proxy.ts";
export { cacheKey, stableSerializeArguments, createCachingProxy, createCacheProxyHandle, getCacheProxyHandle } from "./proxy.ts";
export type { ServiceProxyOptions, ServiceProxyStats } from "./serviceProxy.ts";
export { createServiceProxy, getServiceProxyStats, registerService, ServiceRegistry } from "./serviceProxy.ts";
