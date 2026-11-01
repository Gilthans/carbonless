import {
	AlertIcon,
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
import { useEffect, useState } from "react";
import type { RepoHome } from "../../shared/home";
import { composeSections } from "../../shared/homeSections";
import { Logo } from "../brand/Brand";
import { RelativeTime } from "../RelativeTime";
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
 * a failed read an alert with why, and Retry beside it.
 */
function RepoChip(props: { name: string; query: RepoResult }) {
	const { name, query } = props;
	const client = useQueryClient();
	const failed = failureOf(query);
	const loading = query.data === undefined && !query.isError;
	const retry = useMutation({ mutationFn: () => refetchRepo(client, name) });
	return (
		<span className="inline-flex max-w-full items-center">
			<span
				data-testid="view-repo"
				data-state={failed ? "failed" : loading ? "loading" : "ready"}
				className={`inline-flex h-7 max-w-full items-center gap-1.5 truncate rounded-full border bg-raised px-2.5 text-xs ${failed ? "border-bad/50 text-bad" : "border-edge text-ink-soft"}`}
			>
				{failed ? (
					<Sign label={`${name}: ${failed}`}>
						<AlertIcon size={12} aria-hidden />
					</Sign>
				) : loading ? (
					<Sign label={`Loading ${name}`} className="text-faint">
						<SyncIcon size={12} aria-hidden className={spin} />
					</Sign>
				) : (
					<RepoIcon size={12} aria-hidden className="text-faint" />
				)}
				{name}
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

/**
 * Home: the view's PRs in five sections, the open box, the view's repos
 * and the refresh. Each view repo is its own query (repoQuery), read again
 * every refresh.minutes; the sections are composed here from all of them,
 * so one repo's failure or slowness never holds the others' rows.
 */
export function HomePage() {
	const client = useQueryClient();
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
	const repos = names.map((name, i) => ({
		name,
		query: queries[i] as RepoResult,
	}));
	const refresh = useMutation({
		mutationFn: () =>
			Promise.allSettled(names.map((name) => refetchRepo(client, name))),
	});
	const fetching = useIsFetching({ queryKey: ["home"] }) > 0;
	const busy = fetching || viewSave.saving || refresh.isPending;
	// Until every repo has answered once (a failure counts), sections show
	// placeholders, never a count of rows still to come.
	const loading =
		home.isPending ||
		repos.some(({ query }) => query.data === undefined && !query.isError);
	const sections = composeSections(
		repos.flatMap(({ query }) => query.data?.rows ?? []),
		data?.viewer.login ?? "",
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
							{repos.map((r) => (
								<RepoChip key={r.name} name={r.name} query={r.query} />
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
