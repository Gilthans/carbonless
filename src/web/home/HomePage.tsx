import {
	AlertIcon,
	ClockIcon,
	PencilIcon,
	QuestionIcon,
	RepoIcon,
	SyncIcon,
} from "@primer/octicons-react";
import {
	type UseQueryResult,
	useIsFetching,
	useMutation,
	useQueries,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import type { RepoHome } from "../../shared/home";
import { composeSections } from "../../shared/homeSections";
import { Logo } from "../brand/Brand";
import { RelativeTime } from "../RelativeTime";
import { Settings } from "../Settings";
import { useOpenShortcutsHelp } from "../shortcuts";
import { Tooltip } from "../Tooltip";
import { ErrorMessage } from "../ui";
import { homeQuery, refetchRepo, repoQuery } from "./homeApi";
import { OpenBox } from "./OpenBox";
import { ColumnHeader, Sign } from "./PrRow";
import { Section } from "./Section";
import { ViewSettings } from "./ViewSettings";
import { useViewSave, ViewSaveNotices } from "./viewSave";

const iconButton =
	"flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-ink-soft transition-colors hover:bg-overlay hover:text-ink focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-60 motion-reduce:transition-none";

const spin = "animate-spin motion-reduce:animate-none";

type RepoResult = UseQueryResult<RepoHome>;

/** Why a repo shows nothing new: its GET failed, or its GitHub read did. */
const failureOf = (q: RepoResult): string | null =>
	q.isError ? q.error.message : (q.data?.error ?? null);

/**
 * Where a view repo is: "saving" (added by a save the server hasn't
 * confirmed: nothing is read yet), "loading" (its first read is out),
 * "unread" (it failed and never had a good read: its rows are unknown),
 * "failed" (its last read failed, its rows kept) or "ready".
 */
type RepoState = "saving" | "loading" | "unread" | "failed" | "ready";
function stateOf(query: RepoResult, saved: boolean): RepoState {
	const failed = failureOf(query) !== null;
	if (query.data === undefined) {
		if (query.isError) return "unread";
		return saved ? "loading" : "saving";
	}
	if (failed) return query.data.refreshedAt === null ? "unread" : "failed";
	return "ready";
}

/**
 * The oldest of the repos' last reads (every repo is at least that
 * fresh), `warn` with the reasons when any read failed.
 */
function RefreshStatus(props: {
	repos: { name: string; query: RepoResult }[];
	viewerError: string | null;
}) {
	const failures = [
		...(props.viewerError ? [props.viewerError] : []),
		...props.repos.flatMap(({ name, query }) => {
			const why = failureOf(query);
			return why ? [`${name}: ${why}`] : [];
		}),
	];
	const times = props.repos.map(({ query }) => query.data?.refreshedAt);
	const oldest = times.every((t) => t)
		? (times as string[]).sort()[0]
		: undefined;
	if (props.repos.length === 0 && failures.length === 0) return null;
	return (
		<span
			data-testid="refresh-status"
			className={`flex shrink-0 items-center gap-1.5 text-xs ${failures.length ? "text-warn" : "text-muted"}`}
		>
			{failures.length > 0 && (
				<Sign label={`Refresh failed: ${failures.join("; ")}`}>
					<AlertIcon size={14} aria-hidden />
				</Sign>
			)}
			{oldest ? <RelativeTime iso={oldest} /> : null}
		</span>
	);
}

/**
 * A view repo's chip: its name; a spinner until its first read is in; on
 * a failed read an alert with why, and Retry beside it. The name is a
 * toggle: pressed, Home shows only this repo's PRs (owner, 2026-11-24:
 * "When clicking on one, it filters only PRs from that repo. Clicking
 * again resets to all the repos."). Its hit area is the whole chip, 40px
 * tall; the status sign sits above it, so its tooltip shows on hover.
 */
function RepoChip(props: {
	name: string;
	query: RepoResult;
	state: RepoState;
	pressed: boolean;
	onToggle: () => void;
}) {
	const { name, query, state, pressed } = props;
	const client = useQueryClient();
	const failed = failureOf(query);
	const retry = useMutation({ mutationFn: () => refetchRepo(client, name) });
	// Pressed: accent; a failure keeps its red, on the pressed fill.
	const tone = `${failed ? "border-bad/50 text-bad" : pressed ? "border-accent text-ink" : "border-edge text-ink-soft"} ${pressed ? "bg-accent/15" : "bg-raised"}`;
	return (
		<span className="inline-flex max-w-full items-center">
			<span
				data-testid="view-repo"
				data-state={
					state === "unread" ? "failed" : state === "ready" ? "ready" : state
				}
				data-pressed={pressed || undefined}
				className={`relative inline-flex h-7 max-w-full items-center gap-1.5 rounded-full border px-2.5 text-xs has-focus-visible:outline-2 has-focus-visible:outline-accent ${tone}`}
			>
				{failed ? (
					<Sign label={`${name}: ${failed}`}>
						<AlertIcon size={12} aria-hidden />
					</Sign>
				) : state === "loading" ? (
					<Sign label={`Loading ${name}`} className="text-faint">
						<SyncIcon size={12} aria-hidden className={spin} />
					</Sign>
				) : state === "saving" ? (
					<Sign label={`Waiting for the save: ${name}`} className="text-faint">
						<ClockIcon size={12} aria-hidden />
					</Sign>
				) : (
					<RepoIcon
						size={12}
						aria-hidden
						className={pressed ? "text-accent" : "text-faint"}
					/>
				)}
				<Tooltip
					content={pressed ? "Show all repos" : `Show only ${name}`}
					// A tap's focus keeps the tip open: a toggle closes it.
					dismissKey={pressed}
				>
					{(trigger) => (
						<button
							type="button"
							{...trigger}
							aria-pressed={pressed}
							onClick={props.onToggle}
							// The chip is the target: stretched over it, 40px tall.
							className="min-w-0 truncate outline-none after:absolute after:inset-x-0 after:top-1/2 after:h-10 after:-translate-y-1/2 after:rounded-full after:content-['']"
						>
							{name}
						</button>
					)}
				</Tooltip>
			</span>
			{failed && (
				<Tooltip content={`Retry ${name}`} describe={false}>
					{(trigger) => (
						<button
							type="button"
							{...trigger}
							aria-label={`Retry ${name}`}
							onClick={() => retry.mutate()}
							disabled={query.isFetching}
							className={iconButton}
						>
							<SyncIcon
								size={14}
								aria-hidden
								className={query.isFetching ? spin : ""}
							/>
						</button>
					)}
				</Tooltip>
			)}
		</span>
	);
}

/** Home's search: `?repo=` (lowercased, as view repos are), its repo filter. */
export interface HomeSearch {
	repo?: string;
}

export function parseHomeSearch(raw: Record<string, unknown>): HomeSearch {
	return typeof raw.repo === "string" && raw.repo
		? { repo: raw.repo.toLowerCase() }
		: {};
}

/**
 * Home at `/`: its repo filter is the address's `?repo=`, so reload and
 * back/forward keep it; each toggle is a history entry.
 */
export function HomeRoute() {
	const search = parseHomeSearch(
		useSearch({ strict: false }) as Record<string, unknown>,
	);
	const navigate = useNavigate();
	return (
		<HomePage
			repo={search.repo}
			onRepo={(repo, replace) =>
				void navigate({
					to: "/",
					search: repo ? { repo: repo.toLowerCase() } : {},
					replace,
				})
			}
		/>
	);
}

/**
 * Home: the view's PRs in five sections, the open box, the view's repos
 * and the refresh. Each view repo is its own query (repoQuery), read again
 * every refresh.minutes; the sections are composed here from all of them,
 * so one repo's failure or slowness never holds the others' rows.
 */
export function HomePage(
	props: {
		/** The repo filter asked for (any case); one not in the view is ignored. */
		repo?: string;
		/** Sets the filter (undefined: all repos); without it, the page keeps it. */
		onRepo?: (repo: string | undefined, replace?: boolean) => void;
	} = {},
) {
	const client = useQueryClient();
	const [ownRepo, setOwnRepo] = useState<string | undefined>();
	const wanted = props.onRepo ? props.repo : ownRepo;
	const setRepo =
		props.onRepo ?? ((repo: string | undefined) => setOwnRepo(repo));
	const home = useQuery(homeQuery);
	const [editing, setEditing] = useState(false);
	const openHelp = useOpenShortcutsHelp();
	const viewSave = useViewSave();
	// Each Save: the pencil gets focus back, its tooltip mustn't stay over
	// the sections (a tap keeps a focus tooltip open).
	const [saves, setSaves] = useState(0);
	// A save being made shows at once, laid over the server's last answer.
	const data = home.data && viewSave.shown(home.data);
	const saved = new Set(home.data?.view.repos ?? []);
	const minutes = home.data?.refreshMinutes ?? 2;
	const names = data?.view.repos ?? [];
	// A repo is asked only once the server's view lists it (a save still
	// out would 404 it); one added back shows its cached rows meanwhile.
	const queries = useQueries({
		queries: names.map((name) => ({
			...repoQuery(name, minutes),
			enabled: saved.has(name.toLowerCase()),
		})),
	});
	const repos = names.map((name, i) => {
		const query = queries[i] as RepoResult;
		return {
			name,
			query,
			state: stateOf(query, saved.has(name.toLowerCase())),
		};
	});
	// The repo filter: only among the view's repos, so `?repo=` never
	// reaches the page as anything but one of their names.
	const filter = wanted
		? repos.find(({ name }) => name.toLowerCase() === wanted.toLowerCase())
				?.name
		: undefined;
	// One that isn't (or no longer is) in the view leaves the address once
	// the server's view is in, and no save is out (a failed one brings the
	// repo back, its filter kept).
	const stale = wanted !== undefined && filter === undefined;
	const viewKnown = home.isSuccess && !home.isFetching && !viewSave.saving;
	useEffect(() => {
		if (stale && viewKnown) setRepo(undefined, true);
	}, [stale, viewKnown, setRepo]);
	// What the sections show: the filtered repo's, else every repo's.
	const shown = filter ? repos.filter(({ name }) => name === filter) : repos;
	const refresh = useMutation({
		mutationFn: () =>
			Promise.allSettled(names.map((name) => refetchRepo(client, name))),
	});
	// The view's own reads only: a repo picked in the settings and not
	// saved shows nothing.
	const shownKeys = new Set(names.map((n) => n.toLowerCase()));
	const fetching =
		useIsFetching({
			predicate: ({ queryKey: [home, kind, name] }) =>
				home === "home" &&
				(kind === "view" || (kind === "repo" && shownKeys.has(String(name)))),
		}) > 0;
	const busy = fetching || viewSave.saving || refresh.isPending;
	// Until every repo has answered once (a failure counts), sections show
	// placeholders, never a count of rows still to come.
	// A repo a save is still adding isn't read yet: its chip says so,
	// the counts don't wait for it, unless it is all the filter shows
	// (nothing read: a count would be a 0 still to come).
	const loading =
		home.isPending ||
		shown.some(
			({ state }) =>
				state === "loading" || (filter !== undefined && state === "saving"),
		);
	// Never read: the counts leave these out, and say so.
	const unread = shown.filter(({ state }) => state === "unread");
	const missing =
		unread.length > 0
			? `Without ${unread
					.map(({ name, query }) => `${name}: ${failureOf(query)}`)
					.join("; ")}`
			: undefined;
	// Added by a save not confirmed yet: not read, so not counted either.
	const adding = shown.filter(({ state }) => state === "saving");
	const waiting =
		adding.length > 0
			? `Waiting for the save: ${adding.map(({ name }) => name).join(", ")}`
			: undefined;
	const sections = composeSections(
		shown.flatMap(({ query }) => query.data?.rows ?? []),
	);
	useEffect(() => {
		document.title = "carbonless";
	}, []);

	return (
		<div className="min-h-screen bg-canvas font-sans text-ink">
			<header className="border-b border-line bg-surface header-glow">
				<div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2 sm:flex-nowrap sm:px-6">
					<Tooltip content="Home" describe={false}>
						{(trigger) => (
							<a
								{...trigger}
								href="/"
								aria-label="Home"
								className="shrink-0 rounded-md focus-visible:outline-2 focus-visible:outline-accent"
							>
								<Logo className="h-10 w-10" />
							</a>
						)}
					</Tooltip>
					<OpenBox className="order-last w-full sm:order-none sm:max-w-xl sm:flex-1" />
					<div className="ml-auto flex items-center gap-1">
						{data && (
							<RefreshStatus repos={repos} viewerError={data.viewerError} />
						)}
						<Tooltip content="Refresh from GitHub" describe={false}>
							{(trigger) => (
								<button
									type="button"
									{...trigger}
									aria-label="Refresh"
									onClick={() => refresh.mutate()}
									disabled={refresh.isPending}
									className={iconButton}
								>
									<SyncIcon
										aria-hidden
										className={refresh.isPending ? spin : ""}
									/>
								</button>
							)}
						</Tooltip>
						<Tooltip content="Keyboard shortcuts (?)" describe={false}>
							{(trigger) => (
								<button
									type="button"
									{...trigger}
									aria-label="Keyboard shortcuts"
									onClick={openHelp}
									className={`${iconButton} max-sm:hidden`}
								>
									<QuestionIcon aria-hidden />
								</button>
							)}
						</Tooltip>
						<Settings review={false} />
					</div>
				</div>
			</header>
			<main className="mx-auto max-w-6xl space-y-5 px-3 py-4 sm:px-6">
				{home.isError && <ErrorMessage error={home.error} />}
				{home.isPending &&
					sections.map((s) => (
						<Section key={s.id} section={s} viewer="" loading />
					))}
				{data && (
					<>
						{data.configProblems.length > 0 && (
							<ul
								role="alert"
								className="rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-warn"
							>
								{data.configProblems.map((p) => (
									<li key={p}>{p}</li>
								))}
							</ul>
						)}
						<div className="flex flex-wrap items-center gap-2">
							<h1 className="font-display text-base font-bold">
								{data.view.name}
							</h1>
							{/* Its place is kept, spinning or not: showing it moves
							    nothing (owner, 2026-11-02: "Make sure spinners appear
							    somewhere static so the UI doesn't jitter"). */}
							<span
								data-testid="busy-slot"
								className="inline-flex h-4 w-4 shrink-0 items-center justify-center"
							>
								{busy && (
									// Anything Home shows being read or saved: the view, a
									// repo, a save (owner, 2026-11-01: "If anything is
									// refreshing, we should see a spinner").
									<span
										role="status"
										aria-label={viewSave.saving ? "Saving" : "Loading"}
									>
										<Sign
											label={viewSave.saving ? "Saving…" : "Loading…"}
											className="text-muted"
										>
											<SyncIcon size={14} aria-hidden className={spin} />
										</Sign>
									</span>
								)}
							</span>
							{repos.map((r) => (
								<RepoChip
									key={r.name}
									name={r.name}
									query={r.query}
									state={r.state}
									pressed={r.name === filter}
									onToggle={() =>
										setRepo(r.name === filter ? undefined : r.name)
									}
								/>
							))}
							{data.view.repos.length === 0 ? (
								<button
									type="button"
									onClick={() => setEditing(true)}
									className="cta flex h-10 items-center gap-1.5 rounded-lg px-3 text-sm font-semibold text-ink hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
								>
									Add repos
								</button>
							) : (
								<Tooltip
									content="Edit repos"
									describe={false}
									dismissKey={saves}
								>
									{(trigger) => (
										<button
											type="button"
											{...trigger}
											aria-label="Edit repos"
											onClick={() => setEditing(true)}
											className={iconButton}
										>
											<PencilIcon size={14} aria-hidden />
										</button>
									)}
								</Tooltip>
							)}
						</div>
						{sections.some((s) => s.rows.length > 0) && (
							// One for the page, sticky: the columns are the same in
							// every section.
							<ColumnHeader />
						)}
						{sections.map((s) => (
							<Section
								key={s.id}
								section={s}
								viewer={data.viewer.login}
								loading={loading && data.view.repos.length > 0}
								missing={missing}
								waiting={waiting}
							/>
						))}
						<ViewSettings
							open={editing}
							home={data}
							onSave={(repos) => {
								viewSave.save(repos);
								setSaves((n) => n + 1);
							}}
							onClose={() => setEditing(false)}
						/>
						<ViewSaveNotices save={viewSave} name={data.view.name} />
					</>
				)}
			</main>
		</div>
	);
}
