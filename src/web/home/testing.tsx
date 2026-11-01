// Test helpers for the Home components: rows, views and a fake /api/home.
import { QueryClientProvider } from "@tanstack/react-query";
import { configure, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { vi } from "vitest";
import type {
	HomeRow,
	HomeSection,
	HomeView,
	RepoHome,
	SearchResult,
	SectionId,
} from "../../shared/home";
import { newQueryClient } from "../queryClient";

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
		section: "mine",
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

/**
 * Rows in the order given, as Home sorts them (newest activity first):
 * each a minute older than the one before.
 */
export const inOrder = (rows: HomeRow[]) =>
	rows.map((r, i) => ({ ...r, updatedAt: ago(60 + i) }));

/** A repo's GET held until `release()`: a first read still pending. */
export function held() {
	let release: () => void = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { gate, release };
}

/**
 * Home as the fake API serves it: the view (GET /api/home) and, by
 * section, the rows its repos' GETs answer (each row's section set from
 * its key). `repos`: a repo's answer's other fields (error, refreshedAt…).
 */
export type TestHome = HomeView & {
	sections: HomeSection[];
	repos?: Record<string, Partial<RepoHome>>;
};

export function view(
	rows: Partial<Record<SectionId, HomeRow[]>> = {},
	over: Partial<TestHome> = {},
): TestHome {
	return {
		viewer: person("dan"),
		view: { name: "My PRs", repos: ["acme/api", "acme/console"] },
		configProblems: [],
		viewerError: null,
		refreshMinutes: 2,
		sections: SECTION_IDS.map(
			(id): HomeSection => ({
				id,
				rows: (rows[id] ?? []).map((r) => ({ ...r, section: id })),
			}),
		),
		startedRepos: [],
		...over,
	};
}

/** What GET /api/home/repos/<name> answers for `home`. */
export function repoAnswer(home: TestHome, name: string): RepoHome {
	const key = name.toLowerCase();
	return {
		repo: key,
		rows: home.sections
			.flatMap((s) => s.rows)
			.filter((r) => `${r.owner}/${r.repo}`.toLowerCase() === key),
		refreshedAt: ago(0.1),
		error: null,
		failures: 0,
		...home.repos?.[key],
	};
}

export interface Call {
	method: string;
	url: string;
	body: unknown;
}

type Handler = (call: Call) => unknown;

/**
 * Stubs fetch with a tiny /api/home: GET answers `home`'s view, a repo's
 * GET its rows (repoAnswer), the rest go to `handlers` by "METHOD path"
 * (path without the query) and otherwise answer the view. Every call is
 * recorded.
 */
export function fakeApi(
	home: TestHome,
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
		if (handler) {
			answer = await handler(call);
			// An annotation's answer is the server's row from now on: a
			// repo's read after it shows the same.
			if (
				method === "POST" &&
				path?.endsWith("/annotations") &&
				!(answer instanceof Response)
			) {
				const r = answer as HomeRow;
				const same = (o: HomeRow) =>
					o.number === r.number &&
					`${o.owner}/${o.repo}`.toLowerCase() ===
						`${r.owner}/${r.repo}`.toLowerCase();
				state.home = {
					...state.home,
					sections: state.home.sections.map((sec) => ({
						...sec,
						rows: sec.rows.map((o) =>
							same(o) ? { ...r, section: o.section } : o,
						),
					})),
				};
			}
		} else if (path?.startsWith("/api/home/search")) answer = emptySearch;
		else if (method === "GET" && path?.startsWith("/api/home/repos/")) {
			const [owner = "", repo = ""] = path
				.slice("/api/home/repos/".length)
				.split("/")
				.map(decodeURIComponent);
			answer = repoAnswer(state.home, `${owner}/${repo}`);
		} else {
			const { sections: _, repos: __, ...rest } = state.home;
			answer = rest;
		}
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
	// The app's own defaults: tests see what production does.
	const client = newQueryClient();
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
