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
		<p className="text-slate-600">
			No such page.{" "}
			<Link to="/" className="text-blue-700 underline">
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
		// Each page keeps its own window scroll: going back to a page (tab,
		// link or browser back/forward) puts it where it was left. Saved on
		// leaving, restored once the kept page shows again, before paint.
		scrollRestoration: true,
		getScrollRestorationKey: (location) => location.pathname,
	});
}

declare module "@tanstack/react-router" {
	interface Register {
		router: ReturnType<typeof createAppRouter>;
	}
}
