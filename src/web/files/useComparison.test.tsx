// @vitest-environment jsdom
import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	Outlet,
	RouterProvider,
} from "@tanstack/react-router";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { useLayoutEffect, useRef, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionInfo } from "../../shared/types";
import { PageActive } from "../pageActive";
import { parseSearch, stringifySearch } from "../search";
import { type Comparison, useComparison } from "./comparison";
import { parseFilesSearch } from "./landing";

const oid = (c: string) => c.repeat(40);
const HEAD = oid("f");

const session = (patchsets: number[]): SessionInfo => ({
	pr: { owner: "acme", repo: "widget", number: 7, title: "T", url: "" },
	viewer: "octo",
	snapshotHead: HEAD,
	currentHead: HEAD,
	headMoved: false,
	patchset: patchsets.at(-1) ?? null,
	asOf: null,
	pinnedHead: null,
	// The newest patch set is the head's (the first mark started it).
	patchsets: patchsets.map((number, i) => ({
		number,
		head: i === patchsets.length - 1 && number > 1 ? HEAD : oid(String(number)),
		mergeBase: oid("0"),
		baseBranch: "main",
		startedAt: 1,
		since: number === 1 ? null : number - 1,
		shape: null,
		commits: 1,
	})),
	lastSeen: null,
	head: null,
});

afterEach(cleanup);

const REVIEW = "/r/01testreview0000000000000a";

/**
 * The Files page's comparison, under a router at `/files${search}`, kept
 * mounted as the app keeps its pages: it renders on every route (the
 * Files page and the Overview), active while `state.setActive` says so.
 * `onCommit` runs in a layout effect of each render: before that
 * render's passive effects, as a key pressed right after a commit runs
 * before them.
 */
function setup(search: string, patchsets: number[] = [1]) {
	const state: {
		setSession: (s: SessionInfo) => void;
		setActive: (a: boolean) => void;
		comparison: Comparison | null;
		onCommit: ((c: Comparison) => void) | null;
	} = {
		setSession: () => {},
		setActive: () => {},
		comparison: null,
		onCommit: null,
	};
	function Probe() {
		const [s, setSession] = useState(() => session(patchsets));
		state.setSession = setSession;
		const c = useComparison(s);
		state.comparison = c;
		const latest = useRef(c);
		latest.current = c;
		useLayoutEffect(() => {
			const run = state.onCommit;
			state.onCommit = null;
			run?.(latest.current);
		});
		return null;
	}
	function Kept() {
		const [active, setActive] = useState(true);
		state.setActive = setActive;
		return (
			<>
				<PageActive.Provider value={active}>
					<Probe />
				</PageActive.Provider>
				<Outlet />
			</>
		);
	}
	const root = createRootRoute({ component: Kept });
	const files = createRoute({
		getParentRoute: () => root,
		path: "/r/$id/files",
		validateSearch: parseFilesSearch,
	});
	const overview = createRoute({
		getParentRoute: () => root,
		path: "/r/$id",
	});
	const router = createRouter({
		routeTree: root.addChildren([files, overview]),
		history: createMemoryHistory({
			initialEntries: [`${REVIEW}/files${search}`],
		}),
		scrollRestoration: () => false,
		parseSearch,
		stringifySearch,
	});
	render(<RouterProvider router={router} />);
	return { state, router };
}

const searchOf = (router: { state: { location: { search: unknown } } }) =>
	parseFilesSearch(router.state.location.search as Record<string, unknown>);

describe("useComparison", () => {
	it("a viewed head that became a patch set: the address names the patch set", async () => {
		const { state, router } = setup(`?head=${HEAD}`);
		await waitFor(() =>
			expect(state.comparison?.viewing).toEqual({ kind: "head", oid: HEAD }),
		);
		await act(async () => state.setSession(session([1, 2])));
		await waitFor(() => expect(searchOf(router)).toEqual({ ps: 2 }));
	});

	it("a move made as the head becomes a patch set is kept, not undone by the address's rewrite", async () => {
		const { state, router } = setup(`?head=${HEAD}`);
		await waitFor(() =>
			expect(state.comparison?.base).toEqual({ kind: "patchset", number: 1 }),
		);
		// The session learns of patch set 2 (the head's), and in that very
		// commit, before its passive effects, the base moves to the branch
		// (Ctrl+Shift+[ as the session's answer lands).
		state.onCommit = (c) => {
			expect(c.viewing).toEqual({ kind: "patchset", number: 2 });
			c.set(c.viewing as { kind: "patchset"; number: number }, {
				kind: "branch",
			});
		};
		await act(async () => state.setSession(session([1, 2])));
		expect(state.onCommit).toBeNull();
		await waitFor(() =>
			expect(searchOf(router)).toEqual({
				ps: 2,
				from: "branch",
			}),
		);
		expect(state.comparison?.base).toEqual({ kind: "branch" });
	});

	it("a move made as the page shows again is kept, not undone by writing back the kept view", async () => {
		const { state, router } = setup("?ps=2&from=branch", [1, 2]);
		await waitFor(() =>
			expect(state.comparison?.base).toEqual({ kind: "branch" }),
		);
		// Another tab, then back to Files: its address names no comparison.
		await act(async () => state.setActive(false));
		await act(async () => {
			router.history.push(`${REVIEW}/files`);
		});
		expect(searchOf(router)).toEqual({});
		// In the commit that shows the page, before its passive effects, the
		// base moves to patch set 1.
		state.onCommit = (c) => {
			expect(c.base).toEqual({ kind: "branch" });
			c.set({ kind: "patchset", number: 2 }, { kind: "patchset", number: 1 });
		};
		await act(async () => state.setActive(true));
		expect(state.onCommit).toBeNull();
		await waitFor(() =>
			expect(state.comparison?.base).toEqual({ kind: "patchset", number: 1 }),
		);
		expect(searchOf(router)).toEqual({ ps: 2 });
	});

	it("leaving the page as the head becomes a patch set stays on the other page", async () => {
		const { state, router } = setup(`?head=${HEAD}`);
		await waitFor(() =>
			expect(state.comparison?.viewing).toEqual({ kind: "head", oid: HEAD }),
		);
		// The Overview tab is pressed in the commit that learns of patch set 2.
		state.onCommit = () => {
			router.history.push(REVIEW);
		};
		await act(async () => state.setSession(session([1, 2])));
		expect(state.onCommit).toBeNull();
		await act(async () => {});
		expect(router.state.location.pathname).toBe(REVIEW);
		expect(router.latestLocation.pathname).toBe(REVIEW);
	});
});
