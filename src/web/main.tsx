import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { stripAccessKey } from "./accessKey";
import { threadFocus } from "./files/threadFocus";
import { persistHome, reloadedHome, renderAfter } from "./home/homePersist";
import { newQueryClient } from "./queryClient";
import { createAppRouter } from "./router";
import "./index.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

const queryClient = newQueryClient();
// Before the router reads the URL.
stripAccessKey(window.location, window.history);
const router = createAppRouter();
// Moves end a pending thread focus from the start, before Root's effects.
threadFocus.follow(router.history);

// Home's last answers first (homePersist.ts): Home shows them at once.
void renderAfter(persistHome(queryClient, { restore: !reloadedHome() }), () => {
	createRoot(root).render(
		<StrictMode>
			<QueryClientProvider client={queryClient}>
				<RouterProvider router={router} />
			</QueryClientProvider>
		</StrictMode>,
	);
});
