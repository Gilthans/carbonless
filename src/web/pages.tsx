import {
	lazyRouteComponent,
	useRouter,
	useRouterState,
} from "@tanstack/react-router";
import { Suspense, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ForgetPageScroll, PageActive } from "./pageActive";

/** Pages load on demand: the shell renders before markdown or diff code arrives. */
export const OverviewPage = lazyRouteComponent(
	() => import("./overview/OverviewPage"),
	"OverviewPage",
);
export const FilesPage = lazyRouteComponent(
	() => import("./files/FilesPage"),
	"FilesPage",
);
export const VerdictPage = lazyRouteComponent(
	() => import("./verdict/VerdictPage"),
	"VerdictPage",
);

/** The pages kept alive, by route id, in DOM order. */
const PAGES = {
	"/": OverviewPage,
	"/files": FilesPage,
	"/verdict": VerdictPage,
} as const;
export type PageId = keyof typeof PAGES;
const isPage = (id: string): id is PageId => id in PAGES;

/**
 * The page the router has rendered (its committed matches, so it changes in
 * the same commit as the route, after the page's code has loaded); null on
 * a page that isn't kept (not found).
 */
export function useActivePage(): PageId | null {
	return useRouterState({
		select: (state) => {
			const id = state.matches.at(-1)?.routeId;
			return id && isPage(id) ? id : null;
		},
	});
}

/**
 * Each kept page's window scroll. Saved while the page shows (once a frame
 * while scrolling) and when a navigation starts, before anything changes;
 * restored when the page shows again, in the commit that shows it, before
 * paint. Only the window: the pages' own scrollers stay mounted and keep
 * their offsets by themselves.
 */
function useWindowScrollPerPage(active: PageId | null) {
	const router = useRouter();
	const saved = useRef(new Map<PageId, number>());
	const current = useRef(active);
	useEffect(() => {
		if (typeof history !== "undefined") history.scrollRestoration = "manual";
		let frame = 0;
		const save = () => {
			frame = 0;
			if (current.current) saved.current.set(current.current, window.scrollY);
		};
		const onScroll = () => {
			if (!frame) frame = requestAnimationFrame(save);
		};
		window.addEventListener("scroll", onScroll, { passive: true });
		const unsubscribe = router.subscribe("onBeforeNavigate", () => {
			cancelAnimationFrame(frame);
			save();
		});
		return () => {
			cancelAnimationFrame(frame);
			window.removeEventListener("scroll", onScroll);
			unsubscribe();
		};
	}, [router]);
	useLayoutEffect(() => {
		if (current.current === active) return;
		current.current = active;
		if (active) window.scrollTo(0, saved.current.get(active) ?? 0);
	}, [active]);
	return (id: PageId) => {
		saved.current.delete(id);
	};
}

/**
 * Every page visited so far, mounted once and kept: the one showing is the
 * active route's, the rest are hidden (out of layout, focus and the
 * accessibility tree) with all their state, so switching back finds the page
 * exactly as it was left, at the same window scroll.
 */
export function KeptPages() {
	const active = useActivePage();
	const [visited, setVisited] = useState<PageId[]>(active ? [active] : []);
	if (active && !visited.includes(active)) setVisited([...visited, active]);
	const forget = useWindowScrollPerPage(active);
	const [forgetters] = useState<Record<PageId, () => void>>(() => ({
		"/": () => forget("/"),
		"/files": () => forget("/files"),
		"/verdict": () => forget("/verdict"),
	}));
	return (Object.keys(PAGES) as PageId[])
		.filter((id) => visited.includes(id))
		.map((id) => {
			const Page = PAGES[id];
			const on = id === active;
			return (
				<div
					key={id}
					data-page={id}
					hidden={!on}
					inert={!on}
					aria-hidden={on ? undefined : true}
				>
					<PageActive value={on}>
						<ForgetPageScroll value={forgetters[id]}>
							<Suspense fallback={null}>
								<Page />
							</Suspense>
						</ForgetPageScroll>
					</PageActive>
				</div>
			);
		});
}
