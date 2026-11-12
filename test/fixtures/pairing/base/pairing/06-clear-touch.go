func (c *PlanningCache[CacheKey]) Clear(ctx context.Context, key CacheKey, ext string) error {
    name, err := key.FileName()
    if err != nil {
        return err
    }
    cacheFileGz := c.baseDir.Join(fmt.Sprintf("%s.%s.gz", name, ext))
    err = cacheFileGz.RemoveFile(ctx)
    if err != nil && !errors.Is(err, cloudpath.ErrFileDoesNotExist) {
        return err
    }
    // TODO: Remove this logic after the version has been deployed - XMLs are only relevant for 1 day
    cacheFile := c.baseDir.Join(fmt.Sprintf("%s.%s", name, ext))        
    err = cacheFile.RemoveFile(ctx)        
    if err != nil && !errors.Is(err, cloudpath.ErrFileDoesNotExist) {
        return err
    }
    return nil
}
