import { SyncIcon } from "@primer/octicons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import {
	headQuery,
	overviewQuery,
	postRefresh,
	reviewQuery,
	sessionQuery,
} from "./api";
import { HeadBanner } from "./HeadBanner";
import { AppHeaderHeight, useHeight } from "./sticky";
import { Tooltip } from "./Tooltip";
import { ErrorMessage, safeHref } from "./ui";

const tabClass =
	"-mb-px flex min-h-11 shrink-0 items-center border-b-2 border-transparent px-2.5 text-sm whitespace-nowrap text-slate-600 hover:text-slate-900 focus-visible:outline-2 focus-visible:outline-blue-600 sm:px-3";
const activeTabClass = "border-orange-500 font-semibold text-slate-900";

/**
 * Whether the header is stuck in its compact form: scrolled until only its
 * last row (`row` px) is left on screen.
 */
function useStuck(header: () => HTMLElement | null, row: number, full: number) {
	const [stuck, setStuck] = useState(false);
	// biome-ignore lint/correctness/useExhaustiveDependencies: checked again when the header's height changes.
	useEffect(() => {
		const check = () => {
			const el = header();
			if (!el) return;
			// Stuck at top = row − full height; a pixel of slack for rounding.
			setStuck(el.getBoundingClientRect().bottom <= row + 0.5 && row > 0);
		};
		check();
		window.addEventListener("scroll", check, { passive: true });
		window.addEventListener("resize", check);
		return () => {
			window.removeEventListener("scroll", check);
			window.removeEventListener("resize", check);
		};
	}, [header, row, full]);
	return stuck;
}

/**
 * Layout: PR header, tabs and the current page. The header is sticky: it
 * scrolls until only its last row (tabs, Refresh) is left, which stays at the
 * top as a compact bar with a small title. That row's height is the top of
 * the page's sticky stack (`--app-header`, `AppHeaderHeight`).
 */
export function App() {
	const queryClient = useQueryClient();
	const session = useQuery(sessionQuery);
	// Writes into the session cache (so only once the session has loaded, or
	// its answer could overwrite ours); a failed check leaves the last answer.
	useQuery({ ...headQuery, enabled: session.isSuccess });
	const refresh = useMutation({
		mutationFn: postRefresh,
		onSuccess: (info) => {
			queryClient.setQueryData(sessionQuery.queryKey, info);
			return Promise.all([
				queryClient.invalidateQueries({ queryKey: overviewQuery.queryKey }),
				queryClient.invalidateQueries({ queryKey: reviewQuery.queryKey }),
			]);
		},
	});
	const wide = useRouterState({
		select: (state) => state.location.pathname === "/files",
	});
	const pr = session.data?.pr;
	const prUrl = safeHref(pr?.url);

	const header = useRef<HTMLElement>(null);
	const row = useRef<HTMLDivElement>(null);
	const full = useHeight(() => header.current, null);
	const compact = useHeight(() => row.current, null);
	const findHeader = useCallback(() => header.current, []);
	const stuck = useStuck(findHeader, compact, full);
	useLayoutEffect(() => {
		const root = document.documentElement;
		root.style.setProperty("--app-header", `${compact}px`);
		return () => {
			root.style.removeProperty("--app-header");
		};
	}, [compact]);

	return (
		<AppHeaderHeight.Provider value={compact}>
			<div className="min-h-screen bg-white font-sans text-slate-900">
				<header
					ref={header}
					// Sticks once only the last row is left on screen.
					style={{ top: `${Math.min(0, compact - full)}px` }}
					className={`sticky z-30 border-b border-slate-200 bg-slate-50 transition-shadow duration-200 motion-reduce:transition-none ${
						stuck ? "shadow-sm" : ""
					}`}
				>
					<div className="mx-auto max-w-5xl px-4 pt-4 pb-2 sm:px-6 sm:pt-6">
						{session.isPending && <p className="text-slate-500">Loading…</p>}
						{session.isError && <ErrorMessage error={session.error} />}
						{pr && (
							<div className="flex flex-wrap items-baseline gap-x-2">
								<h1 className="text-xl font-semibold break-words sm:text-2xl">
									{pr.title}
								</h1>
								<span className="text-xl text-slate-500 sm:text-2xl">
									{prUrl ? (
										<a
											href={prUrl}
											target="_blank"
											rel="noreferrer"
											className="hover:underline"
										>
											#{pr.number}
										</a>
									) : (
										`#${pr.number}`
									)}
								</span>
							</div>
						)}
						{pr && (
							<p className="mt-1 text-sm break-all text-slate-600">
								{pr.owner}/{pr.repo}
							</p>
						)}
					</div>
					{refresh.isError && (
						<div className="mx-auto max-w-5xl px-4 pb-2 sm:px-6">
							<ErrorMessage error={refresh.error} />
						</div>
					)}
					{session.data && <HeadBanner info={session.data} />}
					<div
						ref={row}
						data-testid="app-header-row"
						className="mx-auto flex max-w-5xl items-center gap-1 px-2 sm:gap-2 sm:px-6"
					>
						<nav aria-label="PR pages" className="flex shrink-0 self-stretch">
							<Link
								to="/"
								activeOptions={{ exact: true }}
								className={tabClass}
								activeProps={{ className: activeTabClass }}
							>
								Overview
							</Link>
							<Link
								to="/files"
								className={tabClass}
								activeProps={{ className: activeTabClass }}
							>
								Files changed
							</Link>
						</nav>
						{/* The title again, small, once the big one has scrolled away. */}
						<p
							aria-hidden
							data-testid="compact-title"
							className={`min-w-0 flex-1 truncate text-sm font-semibold text-slate-700 transition-[opacity,transform] duration-200 motion-reduce:transition-none ${
								stuck ? "opacity-100" : "translate-y-1 opacity-0"
							}`}
						>
							{pr && (
								<>
									{pr.title}{" "}
									<span className="text-slate-500">#{pr.number}</span>
								</>
							)}
						</p>
						<Tooltip content="Reload the PR from GitHub" describe={false}>
							{(trigger) => (
								<button
									type="button"
									{...trigger}
									aria-label={refresh.isPending ? "Refreshing…" : "Refresh"}
									onClick={() => refresh.mutate()}
									disabled={refresh.isPending}
									className="ml-auto flex h-10 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-sm font-medium text-slate-700 hover:bg-slate-200 focus-visible:outline-2 focus-visible:outline-blue-600 disabled:opacity-60"
								>
									<SyncIcon
										aria-hidden
										className={
											refresh.isPending
												? "animate-spin motion-reduce:animate-none"
												: ""
										}
									/>
									<span className="hidden sm:inline">
										{refresh.isPending ? "Refreshing…" : "Refresh"}
									</span>
								</button>
							)}
						</Tooltip>
					</div>
				</header>
				{/* The diff gets the whole window; the overview stays readable. */}
				<main
					className={`mx-auto px-3 py-4 sm:px-6 sm:py-6 ${wide ? "max-w-screen-2xl" : "max-w-5xl"}`}
				>
					<Outlet />
				</main>
			</div>
		</AppHeaderHeight.Provider>
	);
}
