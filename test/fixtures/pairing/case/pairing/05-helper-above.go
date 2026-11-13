// flagsOr lets a handler's own flags replace the process-wide ones, so tests can run in parallel.
func flagsOr(flags *PlanningCacheFeatureFlags) PlanningCacheFeatureFlags {
    if flags != nil {
        return *flags
    }
    return GetFeatureFlags()
}
// SkipsCacheFor reports whether planning requests for domain must bypass the cache entirely, per the
// skip_cache_domains list of the ff_gpo_planning_cache feature flag.
func (ff PlanningCacheFeatureFlags) SkipsCacheFor(domain string) bool {
    return domainInList(ff.Value.SkipCacheDomains, domain)
}
