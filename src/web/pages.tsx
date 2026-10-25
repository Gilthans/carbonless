import { lazyRouteComponent, useRouterState } from "@tanstack/react-router";
import { Suspense, useState } from "react";
import { PageActive } from "./pageActive";

/** Pages load on demand: the shell renders before markdown or diff code arrives. */
export const OverviewPage = lazyRouteComponent(
	() => import("./overview/OverviewPage"),
	"OverviewPage",
);
export const FilesPage = lazyRouteComponent(
	() => import("./files/FilesPage"),
	"FilesPage",
);

/** The pages kept alive, by route id, in DOM order. */
const PAGES = { "/": OverviewPage, "/files": FilesPage } as const;
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
 * Every page visited so far, mounted once and kept: the one showing is the
 * active route's, the rest are hidden (out of layout, focus and the
 * accessibility tree) with all their state, so switching back finds the page
 * exactly as it was left. The router restores each page's window scroll
 * (`scrollRestoration`, keyed by path).
 */
export function KeptPages() {
	const active = useActivePage();
	const [visited, setVisited] = useState<PageId[]>(active ? [active] : []);
	if (active && !visited.includes(active)) setVisited([...visited, active]);
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
						<Suspense fallback={null}>
							<Page />
						</Suspense>
					</PageActive>
				</div>
			);
		});
}
