/**
 * The URL crb prints for a non-loopback bind carries `?key=`. The server
 * answered the page's own request with a cookie holding the key, so once the
 * page runs the key can leave the address bar (and history, bookmarks,
 * screenshots). Path, other parameters and hash stay.
 */
export function stripAccessKey(
	location: Pick<Location, "href">,
	history: Pick<History, "replaceState" | "state">,
): void {
	const url = new URL(location.href);
	if (!url.searchParams.has("key")) return;
	url.searchParams.delete("key");
	history.replaceState(
		history.state,
		"",
		`${url.pathname}${url.search}${url.hash}`,
	);
}
