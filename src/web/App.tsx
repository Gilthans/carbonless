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
import { createPortal } from "react-dom";
import {
	headQuery,
	invalidateAgentThreads,
	overviewQuery,
	postRefresh,
	REVIEW_KEY,
	sessionQuery,
	verdictQuery,
} from "./api";
import "./agent";
import { AgentChip, CHIP_BOX, useAgentChipPlace } from "./agent/AgentChip";
import { AgentSetupHost } from "./agent/AgentSetup";
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
// pill's column (a phone's narrowest) has no room for both. (Beside the
// agent chip the whole pill may go: compactPillYieldClass.)
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
 * Where the agent chip shows: beside the full logo at the top, and in the
 * sticky row beside the compact mark (`docked`) once its place by the logo
 * starts to leave the screen (under `above`, the find bar), so it never
 * scrolls out of sight. One chip, rendered once into `host` (`chip`) and
 * moved between the two places: it never remounts (no refetch, and what
 * holds on to it, like the agent setup giving focus back, still finds it).
 * The chip has one size (CHIP_BOX), kept for it in the other place, and
 * in both from the first paint while it may come (`place`, not as of a
 * cutoff): neither the title nor the tabs move when it loads or moves.
 */
function useChipDock(hidden: boolean, above: number, asOf: boolean) {
	const [title, setTitle] = useState<HTMLElement | null>(null);
	const [row, setRow] = useState<HTMLElement | null>(null);
	const [docked, setDocked] = useState(false);
	const place = useAgentChipPlace(asOf);
	const [host] = useState(() => {
		const el = document.createElement("span");
		el.style.display = "contents";
		return el;
	});
	const dockedNow = useRef(docked);
	// The chip into its place, keeping focus if it had it.
	useLayoutEffect(() => {
		const at = docked ? row : title;
		if (!at || host.parentNode === at) return;
		const focused = host.contains(document.activeElement)
			? (document.activeElement as HTMLElement)
			: null;
		const move = (at as { moveBefore?: (n: Node, c: Node | null) => void })
			.moveBefore;
		if (move && host.isConnected) {
			try {
				move.call(at, host, null);
			} catch {
				at.appendChild(host);
			}
		} else at.appendChild(host);
		if (focused && document.activeElement !== focused)
			focused.focus({ preventScroll: true });
	}, [docked, row, title, host]);
	useEffect(() => {
		if (!title || hidden) return;
		let frame = 0;
		const update = () => {
			frame = 0;
			const box = title.getBoundingClientRect();
			const next = box.width > 0 && box.top < above;
			if (next === dockedNow.current) return;
			dockedNow.current = next;
			setDocked(next);
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
	}, [title, hidden, above]);
	return {
		setTitle,
		setRow,
		docked,
		/** Whether the header keeps a place for a chip. */
		place,
		// A move closes its tooltip, which would stay at the old place.
		chip: createPortal(<AgentChip dismissKey={docked} asOf={asOf} />, host),
	};
}

/** The chip's space where it isn't, so nothing beside it moves. */
function ChipSpace({ shown }: { shown: boolean }) {
	return shown ? (
		<span aria-hidden data-chip-space className={CHIP_BOX} />
	) : null;
}

/**
 * A chip place: out of the layout (and its gap) when it holds neither the
 * chip nor its kept space, as without an agent.
 */
const chipSlotClass =
	"flex shrink-0 items-center [&:not(:has(button,[data-chip-space]))]:hidden";

/**
 * Whether the compact title's pill gives way to the agent chip: beside it,
 * a phone's narrowest row (360px) has no room for the pill, which then goes
 * below 3.75rem (its padding and a tap-wide title) rather than cover the
 * buttons; it shows from ~420px. Without a chip the pill shows at any
 * width, as it always did. Decided: the owner, 2026-11-11.
 */
const compactPillYieldClass = (chipShown: boolean) =>
	chipShown ? "@max-[3.75rem]:hidden" : "";

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
			// A thread deleted on GitHub shows its conversation as a span.
			// Not waited for: placements can take a while (a push being
			// traced), and Refresh is done once the PR is read again.
			void invalidateAgentThreads(queryClient);
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
	const above = swapped ? findBar : 0;
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
	const chip = useChipDock(yieldToFind, above, !!session.data?.asOf);
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
				{/* Files changed's open find bar, at the very top (FindSlot). */}
				<div
					ref={setSlot}
					data-find-slot
					className="sticky z-[35]"
					style={{ top: "var(--vv-top, 0px)" }}
				/>
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
								{/* The agent chip by the logo, until it docks in the row below. */}
								<span
									ref={chip.setTitle}
									data-testid="agent-chip-slot"
									className={chipSlotClass}
								>
									{chip.docked && <ChipSpace shown={chip.place} />}
								</span>
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
						{/* The one agent chip, placed by useChipDock; none without a PR. */}
						{pr && chip.chip}
						{pr && (
							<p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
								<span className="break-all">
									{pr.owner}/{pr.repo}
								</span>
								{session.data?.asOf && <AsOf iso={session.data.asOf} />}
							</p>
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
							{/*
							 * The agent chip once its place by the logo has scrolled
							 * away; until then its size, so the tabs never move.
							 * Positioned, over the mark's overflowing tap target.
							 */}
							<span
								ref={chip.setRow}
								data-testid="agent-chip-row-slot"
								className={`relative ${chipSlotClass}`}
							>
								{!chip.docked && <ChipSpace shown={chip.place} />}
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
									className={`flex max-w-full min-w-0 items-center gap-x-1 rounded-full bg-raised px-2.5 py-0.5 text-center text-xs leading-4 font-semibold text-ink ring-1 ring-line hover:bg-overlay hover:ring-line-strong sm:px-3 sm:text-sm sm:leading-5 ${compactPillYieldClass(chip.place)}`}
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
