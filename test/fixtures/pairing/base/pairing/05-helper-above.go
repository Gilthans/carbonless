// IsCacheSkippedForDomain reports whether planning requests for domain must bypass the cache entirely, per the
// skip_cache_domains list of the ff_gpo_planning_cache feature flag.
func IsCacheSkippedForDomain(domain string) bool {
    return domainInList(GetFeatureFlags().Value.SkipCacheDomains, domain)
}
