import { HistoryIcon, InfoIcon, SyncIcon } from "@primer/octicons-react";
import {
	useIsFetching,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { Link, Outlet, useNavigate } from "@tanstack/react-router";
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
	REVIEW_KEY,
	sessionQuery,
	verdictQuery,
} from "./api";
import "./agent";
import { AgentChip } from "./agent/AgentChip";
import { AgentSetupHost } from "./agent/AgentSetup";
import { JoinBar } from "./agent/JoinBar";
import { JoinToast } from "./agent/JoinToast";
import { Logo, Mark, Wordmark } from "./brand/Brand";
import { FindButton } from "./files/find/FindButton";
import { findFloat, findState } from "./files/find/findState";
import { HeadToast } from "./files/HeadToast";
import { SyncNotices } from "./files/SyncNotices";
import { KeptPages, useActivePage } from "./pages";
import { fullDate } from "./RelativeTime";
import {
	keepReadingPlace,
	type ReadingPlace,
	readingPlace,
} from "./readingPlace";
import { useReviewId } from "./reviewId";
import { Settings } from "./Settings";
import { SkeletonBar, Spinner } from "./Spinner";
import { useShortcutHelp } from "./shortcuts";
import { useStackTop } from "./stackTop";
import { AppHeaderHeight, FindSlot, useHeight } from "./sticky";
import { Tooltip } from "./Tooltip";
import { EDITOR_KEYS } from "./threads/ReplyBox";
import { useThreadWritesSetup } from "./threads/threadWrites";
import { ErrorMessage, safeHref } from "./ui";
import { NOT_PHONE, useMedia } from "./useMedia";

// Tight on a phone (px-1.5, and no gap in the row): at 360px the compact row
// holds the mark, three tabs, the title, Find in PR, Refresh and Settings.
const tabClass =
	"relative flex min-h-11 shrink-0 items-center rounded-t-md px-1.5 text-sm font-medium whitespace-nowrap text-muted transition-colors hover:text-ink focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent motion-reduce:transition-none sm:px-3";
// The active tab's underline is the brand gradient, over the header's border.
const activeTabClass =
	"font-semibold text-ink after:absolute after:inset-x-1.5 after:-bottom-px after:h-0.5 after:rounded-full after:brand-rule";
// The compact pill's title and number: a 40px tap target (principle 5)
// centred on the text, without growing the pill.
const compactTapClass =
	"relative before:absolute before:inset-x-0 before:top-1/2 before:h-10 before:-translate-y-1/2 before:content-['']";
// The number keeps its width beside the clamped title, and goes when the
// pill's column (a phone's narrowest) has no room for both.
const compactNumberClass = "shrink-0 rounded-full font-medium text-muted";
// Below which column width the number hides, by its digits: the pill's
// padding and gap (1.5rem), the number (~0.45rem a character at text-xs)
// and a 2.5rem floor for the title, so the back-to-top target stays a tap
// wide. Whole class strings, which Tailwind needs to see.
const compactNumberHide = [
	"@max-[5rem]:hidden",
	"@max-[5.5rem]:hidden",
	"@max-[6rem]:hidden",
	"@max-[6.5rem]:hidden",
	"@max-[7rem]:hidden",
	"@max-[7.5rem]:hidden",
];

/** The class hiding the compact pill's number where it would crush the title. */
export function compactNumberHideClass(number: number): string {
	const digits = String(Math.abs(Math.trunc(number))).length;
	return compactNumberHide[digits - 1] ?? "@max-[7.5rem]:hidden";
}

/**
 * As-of mode's marker: the PR is shown as it was at `iso`. Its tooltip says
 * what can't be known about then.
 */
function AsOf({ iso }: { iso: string }) {
	return (
		<Tooltip content="Shown as it was then. Thread resolution and merge conflicts aren't known for a past moment: every thread shows unresolved.">
			{(trigger) => (
				<span
					{...trigger}
					data-testid="as-of"
					// biome-ignore lint/a11y/noNoninteractiveTabindex: the tooltip opens on focus.
					tabIndex={0}
					className="inline-flex min-h-10 items-center gap-1 rounded-md text-xs text-warn focus-visible:outline-2 focus-visible:outline-accent sm:min-h-0"
				>
					<HistoryIcon size={12} aria-hidden />
					as of {fullDate(new Date(iso))}
					<InfoIcon size={12} aria-hidden className="text-muted" />
				</span>
			)}
		</Tooltip>
	);
}

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
 * While `hidden` (out of the layout) it keeps its last measures, and follows
 * the scroll again from where it is once shown. `above`: the find bar's
 * height over it (it sticks that much lower).
 */
function useStickyHeader(
	header: RefObject<HTMLElement | null>,
	row: RefObject<HTMLElement | null>,
	hidden: boolean,
	above: number,
) {
	const [size, setSize] = useState({ offset: 0, stick: 0 });
	const [stuck, setStuck] = useState(false);
	useLayoutEffect(() => {
		const h = header.current;
		const r = row.current;
		if (!h || !r || hidden) return;
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
	}, [header, row, hidden]);
	useEffect(() => {
		const h = header.current;
		if (!h || hidden) return;
		const reduced =
			typeof window.matchMedia === "function"
				? window.matchMedia("(prefers-reduced-motion: reduce)")
				: null;
		let frame = 0;
		const update = () => {
			frame = 0;
			const box = h.getBoundingClientRect();
			// Stuck when its top reaches above - offset.
			const dist = box.top + size.offset - above;
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
	}, [header, size, hidden, above]);
	return { ...size, stuck };
}

/**
 * The open find bar takes the top of Files changed, above the app header,
 * once it shows (findFloat: Files changed renders it when its data is in,
 * so while the review is read or failed the header and its button stay):
 * `swapped`. It pushes the page down by its own height; on a phone the
 * header leaves the layout too (`yielded`). Scrolled down, opening and
 * closing keep the line being read where it was on screen (the page scrolls
 * by however far the swap moved it); at the top of the page the swap shows.
 */
function useFindSwap(
	phone: boolean,
	wide: boolean,
): { swapped: boolean; yielded: boolean } {
	const findOpen = findState.use().open;
	const shown = findFloat.use();
	const swapped = wide && findOpen && shown;
	const place = useRef<ReadingPlace | null>(null);
	const state = useRef({ wide, swapped });
	state.current = { wide, swapped };
	// Noted when the bar opens or closes, before the page renders the swap;
	// dropped by the next frame if no swap came (the bar waits for its data).
	useEffect(
		() =>
			findState.subscribe(() => {
				const { wide, swapped } = state.current;
				if (!wide || findState.get().open === swapped) {
					place.current = null;
					return;
				}
				const noted = readingPlace();
				place.current = noted;
				if (noted)
					requestAnimationFrame(() => {
						if (place.current === noted) place.current = null;
					});
			}),
		[],
	);
	// biome-ignore lint/correctness/useExhaustiveDependencies: runs on each swap.
	useLayoutEffect(() => {
		const was = place.current;
		place.current = null;
		keepReadingPlace(was);
	}, [swapped]);
	return { swapped, yielded: phone && swapped };
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
	useThreadWritesSetup();
	useShortcutHelp(EDITOR_KEYS);
	// Writes into the session cache (so only once the session has loaded, or
	// its answer could overwrite ours); a failed check leaves the last answer.
	useQuery({ ...headQuery, enabled: session.isSuccess });
	const refresh = useMutation({
		mutationFn: postRefresh,
		// A Refresh supersedes a re-read under way: it reads GitHub anew.
		onMutate: () =>
			queryClient.cancelQueries({ queryKey: ["overview-revalidate"] }),
		onSuccess: (info) => {
			queryClient.setQueryData(sessionQuery.queryKey, info);
			return Promise.all([
				queryClient.invalidateQueries({ queryKey: overviewQuery.queryKey }),
				queryClient.invalidateQueries({ queryKey: REVIEW_KEY }),
				// Read only once the tab has shown (refetched only if so).
				queryClient.invalidateQueries({ queryKey: verdictQuery.queryKey }),
			]);
		},
	});
	// The overview page bringing an old read up to date reads the PR from
	// GitHub too: Refresh shows it (its data is on screen, not yet fresh).
	const revalidating = useIsFetching({ queryKey: ["overview-revalidate"] }) > 0;
	const refreshing = refresh.isPending || revalidating;
	// Follows the page showing, which switches only once it can render.
	const wide = useActivePage() === "/r/$id/files";
	// The open find bar goes above the header; a phone's takes its place.
	const phone = !useMedia(NOT_PHONE);
	const { swapped, yielded: yieldToFind } = useFindSwap(phone, wide);
	// The find bar's slot, above the header (FindSlot).
	const [slot, setSlot] = useState<HTMLDivElement | null>(null);
	const findBar = useHeight(() => slot, swapped && slot !== null, !swapped);
	// A session's join request, above everything (and the find bar).
	const [joinSlot, setJoinSlot] = useState<HTMLDivElement | null>(null);
	const joinBar = useHeight(() => joinSlot, joinSlot);
	const above = joinBar + (swapped ? findBar : 0);
	const id = useReviewId();
	const navigate = useNavigate();
	/** The toast's View: the Files page with the comparison target on the head. */
	const viewHead = (oid: string) =>
		navigate({
			to: "/r/$id/files",
			params: { id },
			search: { head: oid },
		});
	const pr = session.data?.pr;
	const prUrl = safeHref(pr?.url);
	// The tab names the PR, so several reviews open side by side tell apart.
	useEffect(() => {
		if (!pr) return;
		document.title = `${pr.title} #${pr.number} · carbonless`;
		return () => {
			document.title = "carbonless";
		};
	}, [pr]);

	const header = useRef<HTMLElement>(null);
	const row = useRef<HTMLDivElement>(null);
	const h1 = useRef<HTMLHeadingElement>(null);
	const {
		offset,
		stick: compact,
		stuck,
	} = useStickyHeader(header, row, yieldToFind, above);
	// The sticky stack's top: the find bar, then the header's stuck row.
	const stackTop = above + (yieldToFind ? 0 : compact);
	useStackTop(stackTop, swapped);
	/** Back to the top, where the full title is; focus goes to it. */
	const toTop = () => {
		const reduced =
			typeof window.matchMedia === "function" &&
			window.matchMedia("(prefers-reduced-motion: reduce)").matches;
		h1.current?.focus({ preventScroll: true });
		window.scrollTo({ top: 0, behavior: reduced ? "auto" : "smooth" });
	};

	return (
		<AppHeaderHeight.Provider value={stackTop}>
			<div className="min-h-screen bg-canvas font-sans text-ink">
				{/*
				 * The top of the page, pinned: a session's join request, then
				 * Files changed's open find bar (FindSlot). Both push the page
				 * down; the header sticks under them (`above`).
				 */}
				<div className="sticky z-[35]" style={{ top: "var(--vv-top, 0px)" }}>
					<div ref={setJoinSlot}>
						<JoinBar />
					</div>
					<div ref={setSlot} data-find-slot />
				</div>
				<header
					ref={header}
					data-app-header
					// Sticks once only the last row (and the border) is left on
					// screen, under the find bar when it shows (which keeps to the
					// visual viewport's top: --vv-top).
					style={{ top: `calc(${above - offset}px + var(--vv-top, 0px))` }}
					// Out of the layout while a phone's find bar takes its place.
					hidden={yieldToFind}
					className={`sticky z-30 border-b border-line bg-surface header-glow transition-shadow duration-200 motion-reduce:transition-none ${
						stuck ? "shadow-header" : ""
					}`}
				>
					<div className="mx-auto max-w-5xl px-4 pt-3 pb-2 sm:px-6 sm:pt-4">
						{session.isPending && (
							// The title's frame, where it will show (principle 8).
							<div
								aria-busy="true"
								data-testid="header-loading"
								className="flex min-h-11 items-center gap-2 sm:min-h-12 sm:gap-3"
							>
								<Spinner label="Loading the PR" size={20} />
								<div className="min-w-0 flex-1 space-y-2.5">
									<SkeletonBar className="w-2/3 max-w-sm" />
									<SkeletonBar className="w-1/3 max-w-40" />
								</div>
							</div>
						)}
						{session.isError && <ErrorMessage error={session.error} />}
						{pr && (
							<div className="flex items-center gap-2 sm:gap-3">
								<Tooltip content="Home" describe={false}>
									{(trigger) => (
										<Link
											{...trigger}
											to="/"
											aria-label="Home"
											data-testid="home-link"
											className="-my-1.5 shrink-0 rounded-full focus-visible:outline-2 focus-visible:outline-accent"
										>
											<Logo className="h-11 w-11 sm:h-12 sm:w-12" />
										</Link>
									)}
								</Tooltip>
								<div
									data-testid="header-title"
									className="flex min-w-0 flex-wrap items-baseline gap-x-2"
								>
									<h1
										ref={h1}
										// Focused by the compact title's "back to top".
										tabIndex={-1}
										className="font-display text-xl font-bold tracking-tight break-words outline-none sm:text-2xl"
									>
										{pr.title}
									</h1>
									<span className="font-display text-xl text-muted sm:text-2xl">
										{prUrl ? (
											<a
												href={prUrl}
												target="_blank"
												rel="noreferrer"
												className="hover:text-link hover:underline"
											>
												#{pr.number}
											</a>
										) : (
											`#${pr.number}`
										)}
									</span>
								</div>
							</div>
						)}
						{pr && (
							<div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
								<span className="break-all">
									{pr.owner}/{pr.repo}
								</span>
								<AgentChip />
								{session.data?.asOf && <AsOf iso={session.data.asOf} />}
							</div>
						)}
					</div>
					{refresh.isError && (
						<div className="mx-auto max-w-5xl px-4 pb-2 sm:px-6">
							<ErrorMessage error={refresh.error} />
						</div>
					)}
					<div
						ref={row}
						data-testid="app-header-row"
						className="mx-auto flex max-w-5xl items-center gap-0 px-2 sm:gap-2 sm:px-6"
					>
						{/*
						 * The mark fades into the compact row as the header sticks
						 * (--compact), where the full logo above has scrolled away, and
						 * goes Home like the logo (inert until stuck). Its slot keeps
						 * its width, so the tabs never move: the link's tap target
						 * overflows the slot (the tabs, positioned, stay on top).
						 */}
						<div className="flex shrink-0 items-center self-stretch">
							<span
								className="flex w-7 shrink-0 justify-center"
								style={{
									opacity: "var(--compact, 0)",
									transform: "scale(calc(0.6 + 0.4 * var(--compact, 0)))",
								}}
							>
								<Tooltip content="Home" describe={false}>
									{(trigger) => (
										<Link
											{...trigger}
											to="/"
											inert={!stuck}
											aria-label="Home"
											data-testid="compact-home-link"
											className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full focus-visible:outline-2 focus-visible:outline-accent"
										>
											<Mark className="h-6 w-6" />
										</Link>
									)}
								</Tooltip>
							</span>
							<nav aria-label="PR pages" className="flex shrink-0 self-stretch">
								<Link
									to="/r/$id"
									params={{ id }}
									// Matched on the path only: a query (the first
									// load's ?key=) must not unmark the tab.
									activeOptions={{ exact: true, includeSearch: false }}
									className={tabClass}
									activeProps={{ className: activeTabClass }}
								>
									Overview
								</Link>
								{/* Short labels on a phone, where the full ones don't fit. */}
								<Link
									to="/r/$id/files"
									params={{ id }}
									aria-label="Files changed"
									activeOptions={{ includeSearch: false }}
									className={tabClass}
									activeProps={{ className: activeTabClass }}
								>
									<span className="sm:hidden">Files</span>
									<span className="hidden sm:inline">Files changed</span>
								</Link>
								<Link
									to="/r/$id/verdict"
									params={{ id }}
									aria-label="Final Verdict"
									activeOptions={{ includeSearch: false }}
									className={tabClass}
									activeProps={{ className: activeTabClass }}
								>
									<span className="sm:hidden">Verdict</span>
									<span className="hidden sm:inline">Final Verdict</span>
								</Link>
							</nav>
						</div>
						{/*
						 * The title again, small, centered between the tabs and Find in PR
						 * on a light pill, fading in over the last stretch before the
						 * header sticks (--compact, scroll-linked). The title takes you
						 * back to the top, to the full title; the number beside it goes
						 * to the PR on GitHub. Both inert until stuck.
						 */}
						<div className="@container flex min-h-10 min-w-0 flex-1 items-center justify-center">
							{pr && (
								<span
									data-testid="compact-title-pill"
									style={{
										opacity: "var(--compact, 0)",
										transform:
											"translateY(calc((1 - var(--compact, 0)) * 0.375rem))",
									}}
									className="flex max-w-full min-w-0 items-center gap-x-1 rounded-full bg-raised px-2.5 py-0.5 text-center text-xs leading-4 font-semibold text-ink ring-1 ring-line hover:bg-overlay hover:ring-line-strong sm:px-3 sm:text-sm sm:leading-5"
								>
									<Tooltip content={pr.title} describe={false}>
										{(trigger) => (
											<button
												type="button"
												{...trigger}
												inert={!stuck}
												aria-label={`Back to top: ${pr.title}`}
												data-testid="compact-title"
												onClick={toTop}
												className={`${compactTapClass} min-w-0 rounded-full focus-visible:outline-2 focus-visible:outline-accent`}
											>
												{/* Two short lines on a phone, one on wider screens. */}
												<span className="line-clamp-2 break-words sm:line-clamp-1">
													{pr.title}
												</span>
											</button>
										)}
									</Tooltip>
									{prUrl ? (
										<Tooltip content="Open on GitHub" describe={false}>
											{(trigger) => (
												<a
													{...trigger}
													href={prUrl}
													target="_blank"
													rel="noreferrer"
													inert={!stuck}
													aria-label={`#${pr.number} on GitHub`}
													data-testid="compact-pr-link"
													className={`${compactTapClass} ${compactNumberClass} ${compactNumberHideClass(pr.number)} hover:text-link hover:underline focus-visible:outline-2 focus-visible:outline-accent`}
												>
													#{pr.number}
												</a>
											)}
										</Tooltip>
									) : (
										<span
											className={`${compactNumberClass} ${compactNumberHideClass(pr.number)}`}
										>
											#{pr.number}
										</span>
									)}
								</span>
							)}
						</div>
						<FindButton />
						<Tooltip content="Reload the PR from GitHub" describe={false}>
							{(trigger) => (
								<button
									type="button"
									{...trigger}
									aria-label={refresh.isPending ? "Refreshing…" : "Refresh"}
									onClick={() => refresh.mutate()}
									data-updating={revalidating || undefined}
									disabled={refresh.isPending}
									className="flex h-10 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-sm font-medium text-ink-soft transition-colors hover:bg-overlay hover:text-ink focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-60 motion-reduce:transition-none"
								>
									<SyncIcon
										aria-hidden
										className={
											refreshing
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
						<Settings />
					</div>
				</header>
				{/* The diff gets the whole window; the overview stays readable. */}
				<main
					// A phone's find bar, in the header's place, meets the page.
					className={`mx-auto px-3 sm:px-6 sm:py-6 ${yieldToFind ? "pt-0 pb-4" : "py-4"} ${wide ? "max-w-screen-2xl" : "max-w-5xl"}`}
				>
					<FindSlot.Provider value={slot}>
						<KeptPages />
					</FindSlot.Provider>
					{/* Only what isn't a kept page: not found. */}
					<Outlet />
				</main>
				{/* Bottom padding keeps it clear of the floating Files button. */}
				<footer
					data-testid="app-footer"
					className="mx-auto flex max-w-5xl items-center justify-center gap-1.5 px-4 pt-2 pb-24 text-xs text-muted sm:pb-10"
				>
					<span>Diff by</span>
					<Mark className="h-4 w-4" />
					<Wordmark className="text-sm" />
				</footer>
				<SyncNotices />
				<JoinToast />
				{/* New commits: a toast, never a banner (nothing above the page moves). */}
				{session.data?.head && (
					<HeadToast
						session={session.data}
						onView={() => {
							const oid = session.data?.head?.oid;
							if (oid) void viewHead(oid);
						}}
					/>
				)}
				<AgentSetupHost />
			</div>
		</AppHeaderHeight.Provider>
	);
}
