import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	Outlet,
	RouterProvider,
} from "@tanstack/react-router";
import type { ReactNode } from "react";

/**
 * `ui` at a review's Files changed in a router of its own, for a component
 * test whose pieces link (`Link`, `useReviewId`) as on the page.
 */
export function inRouter(ui: () => ReactNode): ReactNode {
	const root = createRootRoute({ component: Outlet });
	const files = createRoute({
		getParentRoute: () => root,
		path: "/r/$id/files",
		component: () => <>{ui()}</>,
	});
	const router = createRouter({
		routeTree: root.addChildren([files]),
		history: createMemoryHistory({
			initialEntries: ["/r/01testreview0000000000000a/files"],
		}),
		scrollRestoration: () => false,
	});
	return <RouterProvider router={router} />;
}
