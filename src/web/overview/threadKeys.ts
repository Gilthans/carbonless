/**
 * React keys for threads, which have no id: path, opening time and author
 * name one, numbered apart in the unlikely case two share all three.
 */
export function threadKeys<
	T extends { path: string; createdAt: string; author: string },
>(threads: T[]): [string, T][] {
	const seen = new Map<string, number>();
	return threads.map((t) => {
		const base = `${t.path}\u0000${t.createdAt}\u0000${t.author}`;
		const n = seen.get(base) ?? 0;
		seen.set(base, n + 1);
		return [n ? `${base}\u0000${n}` : base, t];
	});
}
