import { slugify } from "./slug.js";

/**
 * A thread's attention set: who it waits on. Everyone who commented on it,
 * plus the PR author, minus whoever wrote the latest comment; empty once
 * resolved. Bots never join it, and a bot's comment never counts as the
 * latest: the latest human comment decides who is left out. `comments` are
 * the published ones (as of a cutoff, those published by then), oldest
 * first; the caller leaves pending ones out. Logins are one person by slug
 * (case, `_` and `-` aside), spelled as first seen. Stateless for now:
 * adding or removing oneself by hand will make it stored state.
 */
export function attentionSet(input: {
	comments: { login: string; bot: boolean }[];
	prAuthor: string;
	resolved: boolean;
}): string[] {
	if (input.resolved) return [];
	const humans = input.comments.filter((c) => !c.bot && c.login);
	const latest = humans.at(-1);
	const left = latest ? slugify(latest.login) : null;
	const set = new Map<string, string>();
	for (const login of [...humans.map((c) => c.login), input.prAuthor]) {
		const slug = slugify(login);
		if (login && slug !== left && !set.has(slug)) set.set(slug, login);
	}
	return [...set.values()];
}
