import { QueryClient } from "@tanstack/react-query";

/**
 * The page's query client, with the app's defaults (main.tsx), so tests
 * that render a page see what production does.
 */
export function newQueryClient(): QueryClient {
	return new QueryClient({
		defaultOptions: {
			// The server is local; retrying only delays showing gh's error.
			queries: { retry: false, refetchOnWindowFocus: false },
		},
	});
}
