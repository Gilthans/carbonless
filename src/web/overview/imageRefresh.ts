const MINUTE = 60_000;

/**
 * Decides when a broken image in GitHub HTML should refetch the overview.
 * Private-repo images are signed URLs that expire after about five minutes,
 * and the overview is fetched once, so a long-open page ends up with broken
 * images; fresh HTML carries fresh URLs.
 *
 * Refetches at most once a minute, and only when the HTML is at least a
 * minute old: an image that fails right after a fetch is broken for another
 * reason, and refetching would not help (nor loop every minute).
 */
export function createImageRefresher(opts: {
	refetch: () => void;
	now?: () => number;
}) {
	const now = opts.now ?? Date.now;
	let last = Number.NEGATIVE_INFINITY;
	/** Returns whether it refetched. */
	return (fetchedAt: number): boolean => {
		const t = now();
		if (t - fetchedAt < MINUTE || t - last < MINUTE) return false;
		last = t;
		opts.refetch();
		return true;
	};
}
