import {
	createBrowserHistory,
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	Link,
	lazyRouteComponent,
} from "@tanstack/react-router";
import { App } from "./App";

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

const overviewRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/",
	// Pages load on demand: the shell renders before markdown or diff code arrives.
	component: lazyRouteComponent(
		() => import("./overview/OverviewPage"),
		"OverviewPage",
	),
});

const filesRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/files",
	component: lazyRouteComponent(() => import("./files/FilesPage"), "FilesPage"),
});

const routeTree = rootRoute.addChildren([overviewRoute, filesRoute]);

/** The app's router; `initialPath` uses in-memory history (tests). */
export function createAppRouter(options: { initialPath?: string } = {}) {
	return createRouter({
		routeTree,
		history: options.initialPath
			? createMemoryHistory({ initialEntries: [options.initialPath] })
			: createBrowserHistory(),
	});
}

declare module "@tanstack/react-router" {
	interface Register {
		router: ReturnType<typeof createAppRouter>;
	}
}
