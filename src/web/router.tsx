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
import { Logo } from "./brand/Brand";
import { parseFilesSearch } from "./files/landing";
import { FilesPage, OverviewPage } from "./pages";
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

/** Every page with its keyboard shortcuts (one listener, the `?` help). */
function Root() {
	return (
		<ShortcutsProvider>
			<Outlet />
		</ShortcutsProvider>
	);
}

/** Home, until it has its own page (Task 3). */
function HomePlaceholder() {
	return (
		<main className="mx-auto flex min-h-screen max-w-5xl flex-col items-start gap-4 bg-canvas px-4 py-6 font-sans text-ink sm:px-6">
			<Logo className="h-12 w-12" />
			<h1 className="font-display text-2xl font-bold">carbonless</h1>
			<p className="text-muted">Open a review with crb &lt;pr&gt;.</p>
		</main>
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
	if (session.error instanceof ApiError && session.error.status === 404) {
		return (
			<main className="mx-auto min-h-screen max-w-5xl bg-canvas px-4 py-6 font-sans sm:px-6">
				<NotFound reason="No such review." />
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
	component: HomePlaceholder,
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
 * gone once loaded).
 */
const keptPage = () => null;

const overviewRoute = createRoute({
	getParentRoute: () => reviewRoute,
	path: "/",
	loader: () => OverviewPage.preload?.(),
	component: keptPage,
});

const filesRoute = createRoute({
	getParentRoute: () => reviewRoute,
	path: "/files",
	// A thread's file:line link lands here (files/landing.ts).
	validateSearch: parseFilesSearch,
	loader: () => FilesPage.preload?.(),
	component: keptPage,
});

const routeTree = rootRoute.addChildren([
	homeRoute,
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
	});
}

declare module "@tanstack/react-router" {
	interface Register {
		router: ReturnType<typeof createAppRouter>;
	}
}
