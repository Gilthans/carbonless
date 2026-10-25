import { SyncIcon } from "@primer/octicons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Outlet } from "@tanstack/react-router";
import {
	type RefObject,
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
import { KeptPages, useActivePage } from "./pages";
import { AppHeaderHeight } from "./sticky";
import { Tooltip } from "./Tooltip";
import { ErrorMessage, safeHref } from "./ui";

const tabClass =
	"-mb-px flex min-h-11 shrink-0 items-center border-b-2 border-transparent px-2.5 text-sm whitespace-nowrap text-slate-600 hover:text-slate-900 focus-visible:outline-2 focus-visible:outline-blue-600 sm:px-3";
const activeTabClass = "border-orange-500 font-semibold text-slate-900";

/** Scroll distance over which the compact title fades in before sticking. */
export const COMPACT_RAMP = 40;

/**
 * How far the compact row's title has faded in, 0 to 1, for the distance
 * `dist` px still to scroll before the header sticks. Reduced motion skips
 * the ramp: hidden, then shown once stuck.
 */
export function compactProgress(dist: number, reduced: boolean): number {
	if (dist <= 0.5) return 1;
	if (reduced) return 0;
	return Math.min(1, Math.max(0, 1 - dist / COMPACT_RAMP));
}

/**
 * Measures the sticky header and follows the scroll. `offset`: the last
 * row's top inside the header (the header sticks at `-offset`, leaving that
 * row and the border below it); `stick`: what's left on screen once stuck,
 * the top of the page's sticky stack. While scrolling it sets `--compact`
 * (compactProgress) on the header, once per frame, without re-rendering.
 */
function useStickyHeader(
	header: RefObject<HTMLElement | null>,
	row: RefObject<HTMLElement | null>,
) {
	const [size, setSize] = useState({ offset: 0, stick: 0 });
	const [stuck, setStuck] = useState(false);
	useLayoutEffect(() => {
		const h = header.current;
		const r = row.current;
		if (!h || !r) return;
		const measure = () => {
			const offset = r.offsetTop;
			const stick = h.offsetHeight - offset;
			setSize((old) =>
				old.offset === offset && old.stick === stick ? old : { offset, stick },
			);
		};
		measure();
		if (typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(measure);
		observer.observe(h);
		observer.observe(r);
		return () => observer.disconnect();
	}, [header, row]);
	useEffect(() => {
		const h = header.current;
		if (!h) return;
		const reduced =
			typeof window.matchMedia === "function"
				? window.matchMedia("(prefers-reduced-motion: reduce)")
				: null;
		let frame = 0;
		const update = () => {
			frame = 0;
			// Stuck when its top reaches -offset.
			const dist = h.getBoundingClientRect().top + size.offset;
			const progress =
				size.stick > 0 ? compactProgress(dist, reduced?.matches ?? false) : 0;
			h.style.setProperty("--compact", String(progress));
			setStuck(size.stick > 0 && dist <= 0.5);
		};
		const schedule = () => {
			if (!frame) frame = requestAnimationFrame(update);
		};
		update();
		window.addEventListener("scroll", schedule, { passive: true });
		window.addEventListener("resize", schedule);
		return () => {
			cancelAnimationFrame(frame);
			window.removeEventListener("scroll", schedule);
			window.removeEventListener("resize", schedule);
		};
	}, [header, size]);
	return { ...size, stuck };
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
	// Follows the page showing, which switches only once it can render.
	const wide = useActivePage() === "/files";
	const pr = session.data?.pr;
	const prUrl = safeHref(pr?.url);

	const header = useRef<HTMLElement>(null);
	const row = useRef<HTMLDivElement>(null);
	const h1 = useRef<HTMLHeadingElement>(null);
	const { offset, stick: compact, stuck } = useStickyHeader(header, row);
	useLayoutEffect(() => {
		const root = document.documentElement;
		root.style.setProperty("--app-header", `${compact}px`);
		return () => {
			root.style.removeProperty("--app-header");
		};
	}, [compact]);
	/** Back to the top, where the full title is; focus goes to it. */
	const toTop = () => {
		const reduced =
			typeof window.matchMedia === "function" &&
			window.matchMedia("(prefers-reduced-motion: reduce)").matches;
		h1.current?.focus({ preventScroll: true });
		window.scrollTo({ top: 0, behavior: reduced ? "auto" : "smooth" });
	};

	return (
		<AppHeaderHeight.Provider value={compact}>
			<div className="min-h-screen bg-white font-sans text-slate-900">
				<header
					ref={header}
					data-app-header
					// Sticks once only the last row (and the border) is left on screen.
					style={{ top: `${-offset}px` }}
					className={`sticky z-30 border-b border-slate-200 bg-slate-50 transition-shadow duration-200 motion-reduce:transition-none ${
						stuck ? "shadow-sm" : ""
					}`}
				>
					<div className="mx-auto max-w-5xl px-4 pt-4 pb-2 sm:px-6 sm:pt-6">
						{session.isPending && <p className="text-slate-500">Loading…</p>}
						{session.isError && <ErrorMessage error={session.error} />}
						{pr && (
							<div className="flex flex-wrap items-baseline gap-x-2">
								<h1
									ref={h1}
									// Focused by the compact title's "back to top".
									tabIndex={-1}
									className="text-xl font-semibold break-words outline-none sm:text-2xl"
								>
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
						{/*
						 * The title again, small, centered between the tabs and Refresh
						 * on a light pill, fading in over the last stretch before the
						 * header sticks (--compact, scroll-linked). It takes you back to
						 * the top, to the full title. Inert until stuck.
						 */}
						<div className="flex min-w-0 flex-1 justify-center">
							{pr && (
								<Tooltip content={`${pr.title} #${pr.number}`} describe={false}>
									{(trigger) => (
										<button
											type="button"
											{...trigger}
											inert={!stuck}
											aria-label={`Back to top: ${pr.title} #${pr.number}`}
											data-testid="compact-title"
											onClick={toTop}
											style={{
												opacity: "var(--compact, 0)",
												transform:
													"translateY(calc((1 - var(--compact, 0)) * 0.375rem))",
											}}
											className="group flex min-h-10 max-w-full min-w-0 items-center rounded-md focus-visible:outline-2 focus-visible:outline-blue-600"
										>
											<span
												data-testid="compact-title-pill"
												className="min-w-0 rounded-md bg-slate-200/70 px-2 py-0.5 text-center text-xs leading-4 font-semibold text-slate-800 group-hover:bg-slate-300/70 sm:px-2.5 sm:text-sm sm:leading-5"
											>
												{/* Two short lines on a phone, one on wider screens. */}
												<span className="line-clamp-2 break-words sm:line-clamp-1">
													{pr.title}{" "}
													<span className="font-medium text-slate-500">
														#{pr.number}
													</span>
												</span>
											</span>
										</button>
									)}
								</Tooltip>
							)}
						</div>
						<Tooltip content="Reload the PR from GitHub" describe={false}>
							{(trigger) => (
								<button
									type="button"
									{...trigger}
									aria-label={refresh.isPending ? "Refreshing…" : "Refresh"}
									onClick={() => refresh.mutate()}
									disabled={refresh.isPending}
									className="flex h-10 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-sm font-medium text-slate-700 hover:bg-slate-200 focus-visible:outline-2 focus-visible:outline-blue-600 disabled:opacity-60"
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
					<KeptPages />
					{/* Only what isn't a kept page: not found. */}
					<Outlet />
				</main>
			</div>
		</AppHeaderHeight.Provider>
	);
}
