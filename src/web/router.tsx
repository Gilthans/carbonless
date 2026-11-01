import { useQuery } from "@tanstack/react-query";
import {
	createBrowserHistory,
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	Link,
	Outlet,
	useParams,
} from "@tanstack/react-router";
import { useEffect } from "react";
import { App } from "./App";
import { ApiError, bindReview, sessionQuery } from "./api";
import { parseFilesSearch } from "./files/landing";
import { useUnsavedGuard } from "./files/useSetStates";
import { HomePage } from "./home/HomePage";
import { OpeningPage, parseOpeningSearch } from "./OpeningPage";
import { FilesPage, OverviewPage } from "./pages";
import { parseSearch, stringifySearch } from "./search";
import { ShortcutsProvider } from "./shortcuts";

/**
 * Why the server answered this address with its 404 page (a PR that can't
 * be opened, `/pr/...`): its `crb-not-found` meta.
 */
export function notFoundReason(doc: Document = document): string | null {
	return (
		doc.querySelector('meta[name="crb-not-found"]')?.getAttribute("content") ??
		null
	);
}

/** Not found: why when the server said, and the way Home. */
export function NotFound({ reason }: { reason?: string | null }) {
	const why = reason ?? notFoundReason();
	return (
		<div className="flex flex-col items-start gap-2 text-muted">
			<p data-testid="not-found">{why ?? "No such page."}</p>
			<Link
				to="/"
				className="inline-flex min-h-10 items-center text-link underline"
			>
				Home
			</Link>
		</div>
	);
}

/**
 * Every page with its keyboard shortcuts (one listener, the `?` help) and
 * the unsaved-work guard: a review's saves, drafts and thread writes
 * outlive its pages (Home, or the reload to another review, must ask too).
 */
function Root() {
	useUnsavedGuard();
	return (
		<ShortcutsProvider>
			<Outlet />
		</ShortcutsProvider>
	);
}

/**
 * A review's pages. The page is bound to one review for its life (api.ts
 * bindReview): another review's address loads the page anew. An unknown
 * id is the not-found page.
 */
function ReviewRoot() {
	const { id } = useParams({ from: "/r/$id" });
	const bound = bindReview(id);
	useEffect(() => {
		if (!bound) window.location.assign(window.location.href);
	}, [bound]);
	const session = useQuery({ ...sessionQuery, enabled: bound });
	if (!bound) return null;
	const error = session.error instanceof ApiError ? session.error : null;
	// No such review, or one its PR now refuses (merged, closed): say why.
	if (error && [404, 409, 410].includes(error.status)) {
		return (
			<main className="mx-auto min-h-screen max-w-5xl bg-canvas px-4 py-6 font-sans sm:px-6">
				<NotFound
					reason={error.status === 404 ? "No such review." : error.message}
				/>
			</main>
		);
	}
	return <App />;
}

const rootRoute = createRootRoute({
	component: Root,
	notFoundComponent: () => (
		<main className="mx-auto min-h-screen max-w-5xl bg-canvas px-4 py-6 font-sans sm:px-6">
			<NotFound />
		</main>
	),
});

const homeRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/",
	component: HomePage,
});

/** A PR by its address: shows it loading while the server opens its review. */
const openingRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/pr/$owner/$repo/$number",
	validateSearch: parseOpeningSearch,
	component: OpeningPage,
});

const reviewRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/r/$id",
	component: ReviewRoot,
	// In the review's layout (App's <Outlet>).
	notFoundComponent: () => <NotFound />,
});

/*
 * The pages render in the review's layout, kept alive once visited
 * (`KeptPages`), not in its <Outlet>. A route's loader loads its page's
 * code, so the router switches pages only once it can render (`preload` is
 * gone once loaded). A pending component of its own keeps the first load's
 * wait inside the layout: the header shows, and KeptPages spins where the
 * page will be (principle 8), instead of the whole page waiting blank.
 */
const keptPage = () => null;

const overviewRoute = createRoute({
	getParentRoute: () => reviewRoute,
	path: "/",
	loader: () => OverviewPage.preload?.(),
	component: keptPage,
	pendingComponent: keptPage,
});

const filesRoute = createRoute({
	getParentRoute: () => reviewRoute,
	path: "/files",
	// A thread's file:line link lands here (files/landing.ts).
	validateSearch: parseFilesSearch,
	loader: () => FilesPage.preload?.(),
	component: keptPage,
	pendingComponent: keptPage,
});

const routeTree = rootRoute.addChildren([
	homeRoute,
	openingRoute,
	reviewRoute.addChildren([overviewRoute, filesRoute]),
]);

/** The app's router; `initialPath` uses in-memory history (tests). */
export function createAppRouter(options: { initialPath?: string } = {}) {
	return createRouter({
		routeTree,
		history: options.initialPath
			? createMemoryHistory({ initialEntries: [options.initialPath] })
			: createBrowserHistory(),
		// Kept pages restore their own window scroll (`KeptPages`). The
		// router's restoration would also replay inner scrollers by DOM path
		// (stale once pages mount or a snapshot changes), and without it the
		// router scrolls to the top after each navigation: off for every page.
		scrollRestoration: () => false,
		// Values stay strings: `?head=1234567` is a SHA prefix (search.ts).
		parseSearch,
		stringifySearch,
	});
}

declare module "@tanstack/react-router" {
	interface Register {
		router: ReturnType<typeof createAppRouter>;
	}
}
