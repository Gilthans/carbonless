/**
 * What a slow request is waiting on (CAR-296): the page and `crb <pr>` tag
 * each API request with an id (REQUEST_ID_HEADER), and once one has been
 * pending a while they ask `GET /api/activity?req=<id>,…` for its step.
 * The step's name is the span name traces give it (`pnpm test-profile`),
 * its label the short text shown beside the spinner (stepLabel, the map
 * docs/test-profiling.md lists).
 */

/** The header every API request of the page and of `crb <pr>` carries. */
export const REQUEST_ID_HEADER = "x-crb-req";

/** A request id: 8 to 32 url-safe characters. */
export const REQUEST_ID = /^[A-Za-z0-9_-]{8,32}$/;

/** At most this many ids in one ask. */
export const MAX_ACTIVITY_IDS = 16;

/** A request's current step, as `/api/activity` answers it. */
export interface ActivityStep {
	/** The span name (`gh pr view`, `git fetch`, `crb: clone`). */
	name: string;
	/** What it says beside the spinner ("GitHub: pr view"). */
	label: string;
	/** How long it has been on this step (ms, the server's clock). */
	ms: number;
	/** When the step started (ISO, the server's clock). */
	since: string;
}

/** `/api/activity`'s answer: each id's step, null when it has none (or is unknown). */
export interface ActivityAnswer {
	steps: Record<string, ActivityStep | null>;
}

/** The path of the ask for `ids`. */
export const activityPathOf = (ids: readonly string[]): string =>
	`/api/activity?req=${ids.map(encodeURIComponent).join(",")}`;

/** What a named phase's label may carry. */
export interface StepAttrs {
	/** `owner/repo` (checked by the caller). */
	repo?: string;
	/** The batch or page this is (1-based)… */
	n?: number;
	/** …of this many. */
	of?: number;
}

/** An `owner/repo` a label may name. */
const OWNER_REPO = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;

/** Phases: crb's own names for a long wait, and what each says. */
const PHASES: Record<string, (a: StepAttrs) => string> = {
	"crb: clone": (a) =>
		a.repo && OWNER_REPO.test(a.repo)
			? `Cloning ${a.repo}…`
			: "Cloning the repo…",
	"crb: fetch pr": () => "Fetching the PR",
	"crb: snapshot": () => "Reading the diff",
	"crb: split carries": () => "Carrying review marks",
	"crb: fetch commits": () => "Fetching dropped commits",
	"crb: home list": (a) =>
		a.n ? `GitHub: PR list, page ${a.n}` : "GitHub: PR list",
	"crb: home details": (a) =>
		a.n && a.of ? `GitHub: PR details ${a.n} of ${a.of}` : "GitHub: PR details",
	"crb: since": () => "Computing the since view",
	"crb: repo lock": () => "Waiting for the repo lock",
	"crb: working": () => "Working…",
};

/** Whether `name` is one of crb's named phases (they hide the calls under them). */
export const isPhase = (name: string): boolean => Object.hasOwn(PHASES, name);

/** The longest label shown (a gh path cut short). */
const MAX_LABEL = 60;

/**
 * A `gh api` path's words crb shows; any other segment (a branch, a login,
 * an org) shows as "…".
 */
const API_WORDS = new Set([
	"graphql",
	"repos",
	"pulls",
	"issues",
	"comments",
	"commits",
	"reviews",
	"compare",
	"branches",
	"protection",
	"rules",
	"user",
	"users",
	"orgs",
	"members",
	"teams",
	"search",
	"rate_limit",
	"N",
]);

const apiLabel = (path: string) =>
	path
		.split("/")
		.map((segment) => (API_WORDS.has(segment) ? segment : "…"))
		.join("/");

const clip = (text: string) =>
	text.length > MAX_LABEL ? `${text.slice(0, MAX_LABEL - 1)}…` : text;

/**
 * The text of step `name`: a phase's from PHASES; `gh <cmd>` is
 * "GitHub: <cmd>", `git <cmd>` itself (both already free of paths, OIDs
 * and repo names: gh.ts and git.ts name their spans so); anything else
 * "Working…".
 */
export function stepLabel(name: string, attrs: StepAttrs = {}): string {
	if (isPhase(name))
		return clip((PHASES[name] as (a: StepAttrs) => string)(attrs));
	if (name.startsWith("gh api ")) {
		return clip(`GitHub: api ${apiLabel(name.slice(7))}`);
	}
	if (/^gh [a-z-]+(?: [a-z-]+)?$/.test(name)) {
		return clip(`GitHub: ${name.slice(3)}`);
	}
	if (/^git [a-z-]+$/.test(name)) return name;
	return "Working…";
}

/** The line beside a spinner: the label, with whole seconds once past one. */
export function stepText(step: Pick<ActivityStep, "label" | "ms">): string {
	const s = Math.floor(step.ms / 1000);
	return s >= 1 ? `${step.label} · ${s}s` : step.label;
}
