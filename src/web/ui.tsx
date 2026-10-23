/** Only http(s) URLs from PR data become links; anything else renders as text. */
export function safeHref(url: string | undefined): string | undefined {
	if (!url) return undefined;
	try {
		const { protocol } = new URL(url);
		return protocol === "http:" || protocol === "https:" ? url : undefined;
	} catch {
		return undefined;
	}
}

export function ErrorMessage({ error }: { error: Error }) {
	return (
		<p
			role="alert"
			className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"
		>
			{error.message}
		</p>
	);
}
