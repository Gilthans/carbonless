// Home's contract between the server (src/server/home) and the page
// (src/web/home). Spec: docs/superpowers/specs/2026-10-28-home-and-always-on-server-design.md.

export type SectionId = "mine" | "reviewing" | "grabs" | "other" | "closed";
export type Turn =
	| { kind: "none" }
	| { kind: "people"; logins: string[]; label?: "merge" } // viewer first when present
	| { kind: "no-reviewer" };
export interface Person {
	login: string;
	avatarUrl: string;
}
export interface Coverage {
	done: number;
	total: number;
	unit: "lines" | "clusters" | "files";
}
export interface RowReview {
	id: string; // review id, for /r/<id>
	label: string; // "head", or the pinned head's 7-char sha
	pinnedHead: string | null;
	coverage: Coverage;
	lastActedAt: string;
}
export interface Annotations {
	snooze?: { until: string; wakeOnActivity: boolean; at: string };
	waiting?: { who: string; at: string }; // a login or "me"
	note?: string;
}
export interface HomeRow {
	owner: string;
	repo: string;
	number: number;
	title: string;
	url: string;
	author: Person;
	draft: boolean;
	state: "OPEN" | "MERGED" | "CLOSED";
	closedAt: string | null;
	updatedAt: string; // last GitHub activity, the row's age
	checks: "passing" | "failing" | "running" | null;
	decision: "approved" | "changes-requested" | null;
	unresolvedThreads: number;
	turn: Turn; // after the viewer's waiting-on override
	/**
	 * Everyone requested as a reviewer or who submitted a review (teams as
	 * `org/slug`), the viewer first if present, the author never: who the
	 * Waiting-on picker offers.
	 */
	reviewers: string[];
	people: Record<string, Person>; // avatars for turn logins and reviewers
	annotations: Annotations;
	hidden: "snoozed" | "waiting" | null;
	woke: { at: string; by: "activity" | "time" } | null;
	reviews: RowReview[]; // started reviews, newest activity first; [] when none
	openable: boolean; // false: merged/closed with no started review → link to GitHub
}
export interface HomeSection {
	id: SectionId;
	rows: HomeRow[];
} // hidden rows included, flagged; newest updatedAt first
export interface HomeView {
	viewer: Person;
	view: { name: string; repos: string[] };
	configProblems: string[];
	refreshedAt: string | null;
	refreshError: string | null; // last refresh's failure, rows kept
	sections: HomeSection[]; // all five, always, in order
}
export type AnnotationOp =
	| { op: "snooze"; until: string; wakeOnActivity: boolean }
	| { op: "wait"; who: string }
	| { op: "note"; text: string }
	| { op: "wake" }; // clears snooze and waiting
export interface SearchResult {
	repos: { name: string; inView: boolean; openCount: number | null }[];
	prs: {
		owner: string;
		repo: string;
		number: number;
		title: string;
		author: Person;
		state: HomeRow["state"];
		updatedAt: string;
		hidden: HomeRow["hidden"];
	}[];
	scope: string | null; // "owner/repo" when the query named one
	pending: boolean; // a GitHub search is still running; ask again
}
