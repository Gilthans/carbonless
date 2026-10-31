import {
	AlertIcon,
	PencilIcon,
	QuestionIcon,
	RepoIcon,
	SyncIcon,
} from "@primer/octicons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { HomeView } from "../../shared/home";
import { Logo } from "../brand/Brand";
import { RelativeTime } from "../RelativeTime";
import { useOpenShortcutsHelp } from "../shortcuts";
import { Tooltip } from "../Tooltip";
import { ErrorMessage } from "../ui";
import { homeQuery, postHomeRefresh } from "./homeApi";
import { OpenBox } from "./OpenBox";
import { ColumnHeader, Sign } from "./PrRow";
import { Section } from "./Section";
import { ViewSettings } from "./ViewSettings";
import { useViewSave, ViewSaveNotices } from "./viewSave";

/** The page asks for a refresh when shown if the last one is older than this. */
export const STALE_MS = 30_000;

const stale = (home: HomeView | undefined) =>
	!!home &&
	(!home.refreshedAt || Date.now() - Date.parse(home.refreshedAt) > STALE_MS);

const iconButton =
	"flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-ink-soft transition-colors hover:bg-overlay hover:text-ink focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-60 motion-reduce:transition-none";

/** The last refresh's age; `warn` with the reason when it failed. */
function RefreshStatus({ home }: { home: HomeView }) {
	const failed = home.refreshError;
	return (
		<span
			data-testid="refresh-status"
			className={`flex shrink-0 items-center gap-1.5 text-xs ${failed ? "text-warn" : "text-muted"}`}
		>
			{failed && (
				<Sign label={`Refresh failed: ${failed}`}>
					<AlertIcon size={14} aria-hidden />
				</Sign>
			)}
			{home.refreshedAt ? (
				<RelativeTime iso={home.refreshedAt} />
			) : (
				<span>never</span>
			)}
		</span>
	);
}

/**
 * Home: the view's PRs in five sections, the open box, the view's repos
 * and the refresh. Asks the server for a refresh on open and on focus when
 * the last one is older than 30 s; the server refreshes on its own too.
 */
export function HomePage() {
	const client = useQueryClient();
	const home = useQuery(homeQuery);
	const [editing, setEditing] = useState(false);
	const openHelp = useOpenShortcutsHelp();
	const viewSave = useViewSave();
	const refresh = useMutation({
		mutationFn: postHomeRefresh,
		onMutate: () => client.cancelQueries({ queryKey: homeQuery.queryKey }),
		onSuccess: (answer) => client.setQueryData(homeQuery.queryKey, answer),
	});
	// The latest, for the focus listener and the first answer.
	const latest = useRef({ data: home.data, refresh });
	latest.current = { data: home.data, refresh };
	const asked = useRef(false);
	useEffect(() => {
		const maybe = () => {
			const { data, refresh } = latest.current;
			if (stale(data) && !refresh.isPending) refresh.mutate();
		};
		if (home.data && !asked.current) {
			asked.current = true;
			maybe();
		}
		const onVisible = () => {
			if (document.visibilityState === "visible") maybe();
		};
		window.addEventListener("focus", maybe);
		document.addEventListener("visibilitychange", onVisible);
		return () => {
			window.removeEventListener("focus", maybe);
			document.removeEventListener("visibilitychange", onVisible);
		};
	}, [home.data]);
	useEffect(() => {
		document.title = "carbonless";
	}, []);

	// A save being made shows at once, laid over the server's last answer.
	const data = home.data && viewSave.shown(home.data);
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
						{data && <RefreshStatus home={data} />}
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
										className={
											refresh.isPending
												? "animate-spin motion-reduce:animate-none"
												: ""
										}
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
				{home.isPending && <p className="text-muted">Loading…</p>}
				{home.isError && <ErrorMessage error={home.error} />}
				{refresh.isError && <ErrorMessage error={refresh.error} />}
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
							{viewSave.saving && (
								<span role="status" aria-label="Saving">
									<Sign label="Saving…" className="text-muted">
										<SyncIcon
											size={14}
											aria-hidden
											className="animate-spin motion-reduce:animate-none"
										/>
									</Sign>
								</span>
							)}
							{data.view.repos.map((r) => (
								<span
									key={r}
									data-testid="view-repo"
									className="inline-flex h-7 max-w-full items-center gap-1.5 truncate rounded-full border border-edge bg-raised px-2.5 text-xs text-ink-soft"
								>
									<RepoIcon size={12} aria-hidden className="text-faint" />
									{r}
								</span>
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
								<Tooltip content="Edit repos" describe={false}>
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
						{data.sections.some((s) => s.rows.length > 0) && (
							// One for the page, sticky: the columns are the same in
							// every section.
							<ColumnHeader />
						)}
						{data.sections.map((s) => (
							<Section key={s.id} section={s} viewer={data.viewer.login} />
						))}
						<ViewSettings
							open={editing}
							home={data}
							onSave={viewSave.save}
							onClose={() => setEditing(false)}
						/>
						<ViewSaveNotices save={viewSave} name={data.view.name} />
					</>
				)}
			</main>
		</div>
	);
}
