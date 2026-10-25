import {
	createBrowserHistory,
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	Link,
} from "@tanstack/react-router";
import { App } from "./App";
import { FilesPage, OverviewPage } from "./pages";

function NotFound() {
	return (
		<p className="text-muted">
			No such page.{" "}
			<Link to="/" className="text-link underline">
				Back to the overview
			</Link>
		</p>
	);
}

const rootRoute = createRootRoute({
	component: App,
	notFoundComponent: NotFound,
});

/*
 * The pages render in the root layout, kept alive once visited (`KeptPages`),
 * not in its <Outlet>. A route's loader loads its page's code, so the router
 * switches pages only once it can render (`preload` is gone once loaded).
 */
const keptPage = () => null;

const overviewRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/",
	loader: () => OverviewPage.preload?.(),
	component: keptPage,
});

const filesRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/files",
	loader: () => FilesPage.preload?.(),
	component: keptPage,
});

const routeTree = rootRoute.addChildren([overviewRoute, filesRoute]);

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
