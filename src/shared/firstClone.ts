/**
 * What an open waiting on crb's first clone of a repo says, beside its
 * spinner and on `crb <pr>`'s stderr (CAR-291): the owner's wording.
 */
export const firstCloneMessage = (ownerRepo: string): string =>
	`Cloning ${ownerRepo} for the first time, this might take a while`;

/** GET /api/clones/<owner>/<repo>: whether its first clone runs now. */
export interface CloneState {
	cloning: boolean;
}

/** The path of that answer, its segments escaped. */
export const clonePathOf = (owner: string, repo: string): string =>
	`/api/clones/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
