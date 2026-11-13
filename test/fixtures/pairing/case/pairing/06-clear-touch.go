func (c *PlanningCache[CacheKey]) GetFingerprint(ctx context.Context, key CacheKey) (string, error) {
    value, err := c.Get(ctx, key, FingerprintExt)
    if err != nil {
        return "", err
    }
    return string(value), nil
}
// SetFingerprint with "" removes the stored one, so a report without a fingerprint is never revalidated.
func (c *PlanningCache[CacheKey]) SetFingerprint(ctx context.Context, key CacheKey, fingerprint string) error {
    if fingerprint == "" {
        return c.Clear(ctx, key, FingerprintExt)
    }
    return c.Put(ctx, key, FingerprintExt, []byte(fingerprint))
}
func (c *PlanningCache[CacheKey]) Touch(ctx context.Context, key CacheKey, ext string) error {
    name, err := key.FileName()
    if err != nil {
        return err
    }
    return c.baseDir.Join(fmt.Sprintf("%s.%s.gz", name, ext)).Touch(ctx)
}
func (c *PlanningCache[CacheKey]) Clear(ctx context.Context, key CacheKey, ext string) error {
    name, err := key.FileName()
    if err != nil {
        return err
    }
    err = c.baseDir.Join(fmt.Sprintf("%s.%s.gz", name, ext)).RemoveFile(ctx)
    if err != nil && !errors.Is(err, cloudpath.ErrFileDoesNotExist) {
        return err
    }
    return nil
}
