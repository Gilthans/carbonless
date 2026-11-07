// @vitest-environment jsdom
import { QueryClient } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionInfo } from "../shared/types";
import { headQuery, sessionQuery } from "./api";
import { HeadBanner } from "./HeadBanner";

const info: SessionInfo = {
	pr: {
		owner: "acme",
		repo: "widget",
		number: 12,
		title: "Add widget cache",
		url: "https://github.com/acme/widget/pull/12",
	},
	viewer: "octo",
	snapshotHead: `${"abcdef1234567890".repeat(2)}abcdef12`,
	currentHead: "f".repeat(40),
	headMoved: true,
	patchset: 1,
	asOf: null,
	pinnedHead: null,
	patchsets: [],
	lastSeen: null,
};

describe("HeadBanner", () => {
	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
	});

	it("explains the pinned snapshot and links to the PR", () => {
		render(<HeadBanner info={info} />);
		const banner = screen.getByRole("status");
		expect(banner).toHaveTextContent(
			"New commits were pushed to this PR. You're reviewing the snapshot from abcdef1; there's no way to move to the new head yet.",
		);
		const link = screen.getByRole("link", { name: /PR/ });
		expect(link).toHaveAttribute("href", info.pr.url);
		expect(link).toHaveAttribute("target", "_blank");
		expect(link).toHaveAttribute("rel", "noreferrer");
	});

	it("only asks for a Refresh on a review that has not started", () => {
		render(<HeadBanner info={{ ...info, patchset: null }} />);
		const note = screen.getByRole("status");
		expect(note).toHaveTextContent(
			"New commits were pushed to this PR. Press Refresh to load them.",
		);
		expect(note).not.toHaveTextContent("snapshot");
		expect(screen.queryByRole("link")).toBeNull();
	});

	it("names the pinned head and says newer commits exist, without asking for a Refresh", () => {
		for (const patchset of [null, 1]) {
			const { unmount } = render(
				<HeadBanner
					info={{ ...info, patchset, pinnedHead: info.snapshotHead }}
				/>,
			);
			const banner = screen.getByRole("status");
			expect(banner).toHaveTextContent(
				"Viewing abcdef1; this PR has newer commits.",
			);
			expect(banner).not.toHaveTextContent("Refresh");
			expect(banner.className).toContain("bg-warn/10");
			unmount();
		}
	});

	it("shows nothing while the head has not moved", () => {
		const { container } = render(
			<HeadBanner info={{ ...info, headMoved: false }} />,
		);
		expect(container).toBeEmptyDOMElement();
	});

	it("links only to http(s) PR urls", () => {
		render(
			<HeadBanner
				info={{ ...info, pr: { ...info.pr, url: "javascript:alert(1)" } }}
			/>,
		);
		expect(screen.getByRole("status")).toBeInTheDocument();
		expect(screen.queryByRole("link")).toBeNull();
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
