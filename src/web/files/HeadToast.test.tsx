// @vitest-environment jsdom
import { QueryClient } from "@tanstack/react-query";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionInfo } from "../../shared/types";
import { headQuery, sessionQuery } from "../api";
import { HeadToast, TOAST_MS, toastHead } from "./HeadToast";

const oid = (c: string) => c.repeat(40);

const info: SessionInfo = {
	pr: {
		owner: "acme",
		repo: "widget",
		number: 12,
		title: "Add widget cache",
		url: "https://github.com/acme/widget/pull/12",
	},
	viewer: "octo",
	snapshotHead: oid("1"),
	currentHead: oid("f"),
	headMoved: true,
	patchset: 1,
	asOf: null,
	pinnedHead: null,
	patchsets: [
		{
			number: 1,
			head: oid("1"),
			mergeBase: oid("0"),
			startedAt: 1,
			since: null,
			shape: null,
			commits: 2,
		},
	],
	lastSeen: { head: oid("1"), at: 1 },
	head: { oid: oid("f"), mergeBase: oid("0"), baseBranch: "main", commits: 3 },
};

describe("toastHead", () => {
	it("is the PR's head when newer than the newest patch set and not seen on the last open", () => {
		expect(toastHead(info)?.oid).toBe(oid("f"));
		expect(toastHead({ ...info, lastSeen: null })?.oid).toBe(oid("f"));
	});
	it("is nothing when the head is the newest patch set, unknown, or the one last opened on", () => {
		expect(
			toastHead({
				...info,
				head: {
					...(info.head as NonNullable<SessionInfo["head"]>),
					oid: oid("1"),
				},
			}),
		).toBeNull();
		expect(toastHead({ ...info, head: null })).toBeNull();
		expect(
			toastHead({ ...info, lastSeen: { head: oid("f"), at: 2 } }),
		).toBeNull();
	});
	it("before any patch set, newer than the snapshot reviewed", () => {
		expect(toastHead({ ...info, patchsets: [], patchset: null })?.oid).toBe(
			oid("f"),
		);
		expect(
			toastHead({
				...info,
				patchsets: [],
				patchset: null,
				snapshotHead: oid("f"),
			}),
		).toBeNull();
	});
});

describe("HeadToast", () => {
	afterEach(() => {
		cleanup();
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it("says the count and the commit, as a status that takes no focus, with View and a dismiss", async () => {
		const user = userEvent.setup();
		const onView = vi.fn();
		render(<HeadToast session={info} onView={onView} />);
		const toast = screen.getByRole("status");
		expect(toast).toHaveTextContent("3 new commits · fffffff");
		expect(document.activeElement).toBe(document.body);
		await user.click(screen.getByRole("button", { name: "View" }));
		expect(onView).toHaveBeenCalledTimes(1);
		// Viewing dismisses it.
		expect(screen.queryByRole("status")).toBeNull();
	});

	it("dismisses, and stays dismissed for that head; a newer head shows again", async () => {
		const user = userEvent.setup();
		const { rerender } = render(<HeadToast session={info} onView={() => {}} />);
		await user.click(screen.getByRole("button", { name: "Dismiss" }));
		expect(screen.queryByRole("status")).toBeNull();
		rerender(<HeadToast session={{ ...info }} onView={() => {}} />);
		expect(screen.queryByRole("status")).toBeNull();
		const head = info.head as NonNullable<SessionInfo["head"]>;
		rerender(
			<HeadToast
				session={{ ...info, head: { ...head, oid: oid("e"), commits: 1 } }}
				onView={() => {}}
			/>,
		);
		expect(screen.getByRole("status")).toHaveTextContent(
			"1 new commit · eeeeeee",
		);
	});

	it("goes by itself after TOAST_MS", () => {
		vi.useFakeTimers();
		render(<HeadToast session={info} onView={() => {}} />);
		expect(screen.getByRole("status")).toBeInTheDocument();
		act(() => {
			vi.advanceTimersByTime(TOAST_MS - 1);
		});
		expect(screen.getByRole("status")).toBeInTheDocument();
		act(() => {
			vi.advanceTimersByTime(1);
		});
		expect(screen.queryByRole("status")).toBeNull();
	});

	it("shows nothing for the head last opened on, a pinned head, an as-of view or a merged PR (no head)", () => {
		for (const s of [
			{ ...info, lastSeen: { head: oid("f"), at: 2 } },
			{ ...info, head: null, pinnedHead: oid("1") },
			{ ...info, head: null, asOf: "2026-01-01T00:00:00Z" },
			{ ...info, head: null },
		]) {
			const { container, unmount } = render(
				<HeadToast session={s} onView={() => {}} />,
			);
			expect(container).toBeEmptyDOMElement();
			unmount();
		}
	});
});

describe("headQuery", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("polls every 5 minutes and writes its answer into the session cache", async () => {
		expect(headQuery.refetchInterval).toBe(300_000);
		expect(headQuery.refetchOnWindowFocus).toBe(true);
		expect(headQuery.staleTime).toBe(30_000);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(JSON.stringify(info), { status: 200 })),
		);
		const client = new QueryClient();
		client.setQueryData(sessionQuery.queryKey, { ...info, headMoved: false });
		await client.fetchQuery(headQuery);
		expect(client.getQueryData(sessionQuery.queryKey)).toEqual(info);
	});
});
