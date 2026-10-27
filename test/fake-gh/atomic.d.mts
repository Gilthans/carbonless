/**
 * Writes `data` to `path` so that no reader ever sees it half-written: the
 * whole file goes to a temp name in the same directory, then is renamed
 * over `path`. A reader gets the old file or the new one, never a
 * truncated one.
 */
export function writeFileAtomic(path: string, data: string): void;
