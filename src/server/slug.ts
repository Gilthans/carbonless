/** Reviewer slug: lowercase, characters outside [a-z0-9-] become "-", max 64. */
export function slugify(login: string): string {
	return login
		.toLowerCase()
		.replace(/[^a-z0-9-]/g, "-")
		.slice(0, 64);
}
