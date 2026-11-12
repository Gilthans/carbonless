/** What a gh call is about: its repos (owner/repo, lowercased), none, or a form route.mjs doesn't know. */
export type CallRepos =
	| { kind: "repos"; repos: string[] }
	| { kind: "none" }
	| { kind: "unknown" };
/** The repositories a gh call is about, as gh.mjs answers it. */
export function repoOf(args: readonly string[]): CallRepos;
/** Whether `value` is a router file's content. */
export function isRouter(value: unknown): boolean;
/** Where a call reads its scenario, or the message of a stray. */
export function routeCall(
	path: string,
	args: readonly string[],
	env: Record<string, string | undefined>,
):
	| {
			stray?: undefined;
			scenarioPath: string;
			text: string;
			logPath: string | undefined;
	  }
	| { stray: string };
