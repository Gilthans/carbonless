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

/**
 * The Files page's comparison, under a router at `search`. `onCommit`
 * runs in a layout effect of each render: before that render's passive
 * effects, as a key pressed right after a commit runs before them.
 */
function setup(search: string) {
	const state: {
		setSession: (s: SessionInfo) => void;
		comparison: Comparison | null;
		onCommit: ((c: Comparison) => void) | null;
	} = { setSession: () => {}, comparison: null, onCommit: null };
	function Probe() {
		const [s, setSession] = useState(() => session([1]));
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
	const root = createRootRoute({ component: Outlet });
	const files = createRoute({
		getParentRoute: () => root,
		path: "/r/$id/files",
		validateSearch: parseFilesSearch,
		component: Probe,
	});
	const router = createRouter({
		routeTree: root.addChildren([files]),
		history: createMemoryHistory({
			initialEntries: [`/r/01testreview0000000000000a/files${search}`],
		}),
		scrollRestoration: () => false,
		parseSearch,
		stringifySearch,
	});
	render(<RouterProvider router={router} />);
	return { state, router };
}

describe("useComparison", () => {
	it("a viewed head that became a patch set: the address names the patch set", async () => {
		const { state, router } = setup(`?head=${HEAD}`);
		await waitFor(() =>
			expect(state.comparison?.viewing).toEqual({ kind: "head", oid: HEAD }),
		);
		await act(async () => state.setSession(session([1, 2])));
		await waitFor(() =>
			expect(parseFilesSearch(router.state.location.search)).toEqual({ ps: 2 }),
		);
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
			expect(parseFilesSearch(router.state.location.search)).toEqual({
				ps: 2,
				from: "branch",
			}),
		);
		expect(state.comparison?.base).toEqual({ kind: "branch" });
	});
});
