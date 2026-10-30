// Test helpers for the Home components: rows, views and a fake /api/home.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { configure, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { vi } from "vitest";
import type {
	HomeRow,
	HomeSection,
	HomeView,
	SearchResult,
	SectionId,
} from "../../shared/home";

// A loaded machine (several worktrees' suites at once) can take over the
// default second to render Home's first answer.
configure({ asyncUtilTimeout: 3000 });

export const NOW = Date.now();
export const ago = (minutes: number) =>
	new Date(NOW - minutes * 60_000).toISOString();

export const person = (login: string) => ({
	login,
	avatarUrl: `https://avatars.example/${login}.png`,
});

export function row(over: Partial<HomeRow> = {}): HomeRow {
	return {
		owner: "acme",
		repo: "api",
		number: 1,
		title: "A change",
		url: `https://github.com/acme/api/pull/${over.number ?? 1}`,
		author: person("tomer"),
		draft: false,
		state: "OPEN",
		closedAt: null,
		updatedAt: ago(60),
		checks: null,
		decision: null,
		unresolvedThreads: 0,
		turn: { kind: "none" },
		reviewers: [],
		people: {},
		annotations: {},
		hidden: null,
		woke: null,
		reviews: [],
		openable: true,
		...over,
	};
}

export const SECTION_IDS: SectionId[] = [
	"mine",
	"reviewing",
	"grabs",
	"other",
	"closed",
];

export function view(
	rows: Partial<Record<SectionId, HomeRow[]>> = {},
	over: Partial<HomeView> = {},
): HomeView {
	return {
		viewer: person("dan"),
		view: { name: "My PRs", repos: ["acme/api", "acme/console"] },
		configProblems: [],
		refreshedAt: ago(0.1),
		refreshError: null,
		sections: SECTION_IDS.map(
			(id): HomeSection => ({ id, rows: rows[id] ?? [] }),
		),
		...over,
	};
}

export interface Call {
	method: string;
	url: string;
	body: unknown;
}

type Handler = (call: Call) => unknown;

/**
 * Stubs fetch with a tiny /api/home: GET answers `home`, the rest go to
 * `handlers` by "METHOD path" (path without the query) and otherwise answer
 * the view. Every call is recorded.
 */
export function fakeApi(
	home: HomeView,
	handlers: Record<string, Handler> = {},
) {
	const calls: Call[] = [];
	const state = { home };
	const fetch = vi.fn(async (input: string, init?: RequestInit) => {
		const method = init?.method ?? "GET";
		const body = init?.body ? JSON.parse(String(init.body)) : undefined;
		const call = { method, url: input, body };
		calls.push(call);
		const path = input.split("?")[0];
		const handler = handlers[`${method} ${path}`];
		let answer: unknown;
		if (handler) answer = await handler(call);
		else if (path?.startsWith("/api/home/search")) answer = emptySearch;
		else answer = state.home;
		if (answer instanceof Response) return answer;
		return new Response(JSON.stringify(answer), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	});
	vi.stubGlobal("fetch", fetch);
	return { calls, state, fetch };
}

export const emptySearch: SearchResult = {
	repos: [],
	prs: [],
	scope: null,
	pending: false,
	reposPending: false,
};

export function renderWithQuery(ui: ReactElement) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return {
		client,
		...render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>),
	};
}

/** The tooltip showing now (a describe={false} one is aria-hidden). */
export async function shownTooltip(): Promise<HTMLElement> {
	return waitFor(() => {
		const tip = screen
			.queryAllByRole("tooltip", { hidden: true })
			.find((t) => !t.hidden);
		if (!tip) throw new Error("no tooltip showing");
		return tip;
	});
}
