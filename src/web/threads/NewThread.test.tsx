// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrOverview } from "../../shared/types";
import {
	type AgentCommentContext,
	AgentComposer,
	headFacts,
} from "../agent/AgentComposer";
import {
	askAgent,
	getAgentWrites,
	resetAgentWrites,
} from "../agent/agentWrites";
import {
	getAgentComposers,
	openAgentComposer,
	resetAgentComposers,
	useAgentComposers,
} from "../agent/askAgentAction";
import { conversation } from "../agent/threadAgentFixtures";
import { overviewQuery } from "../api";
import type { CodeSpan } from "../files/selectionActions";
import { useDrafts } from "./drafts";
import { NewThread } from "./NewThread";
import {
	getComposers,
	type NewThreadItem,
	newThreadItems,
	openComposer,
	resetComposers,
	targetOf,
	useComposers,
} from "./newThreads";
import { threadWritesFor } from "./threadWrites";

afterEach(() => {
	cleanup();
	resetComposers();
	resetAgentComposers();
	resetAgentWrites();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

const LINE: CodeSpan = {
	path: "src/a.ts",
	commit: "head1",
	subject: "line",
	startSide: "RIGHT",
	startLine: 3,
	side: "RIGHT",
	line: 4,
	startCol: 2,
	endCol: 7,
};
const FILE: CodeSpan = { path: "src/a.ts", commit: "head1", subject: "file" };

/** A comment composer on the span with `text` typed (a draft), and the agent composers it may open. */
function show(
	span: CodeSpan,
	text: string,
	opts: {
		writes?: PrOverview["writes"];
		headUnsure?: boolean;
		noOverview?: boolean;
	} = {},
) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: Infinity } },
	});
	if (!opts.noOverview) {
		client.setQueryData(overviewQuery.queryKey, {
			writes: opts.writes ?? "on",
		} as PrOverview);
	}
	const writer = threadWritesFor(client);
	const id = openComposer(span, "cid1");
	if (text) writer.drafts.setNew(id, targetOf(span), text);
	function Page() {
		const open = useComposers().some((c) => c.clientId === id);
		const asking = useAgentComposers();
		const item: NewThreadItem = {
			clientId: id,
			span,
			text: writer.drafts.newThread(id)?.text ?? "",
			sending: false,
			focus: false,
		};
		return (
			<>
				{(open || writer.drafts.newThread(id)) && (
					<NewThread item={item} quote="q" headUnsure={opts.headUnsure} />
				)}
				{asking.map((c) => (
					<AgentComposer
						key={c.clientId}
						clientId={c.clientId}
						span={c.span}
						quote="q"
					/>
				))}
			</>
		);
	}
	render(
		<QueryClientProvider client={client}>
			<Page />
		</QueryClientProvider>,
	);
	return { writer, id, client };
}

describe("NewThread's agent button", () => {
	it("doesn't join a question still being asked on the span: a composer of its own", async () => {
		let land: (r: Response) => void = () => {};
		vi.stubGlobal(
			"fetch",
			vi.fn(() => new Promise<Response>((r) => (land = r))),
		);
		const { client } = show(LINE, "second thought");
		act(() => {
			openAgentComposer(LINE, "a1", "first");
			askAgent(client, LINE, "first", "a1");
		});
		expect(getAgentWrites().pending.get("a1")).toBeTruthy();
		act(() =>
			fireEvent.click(
				screen.getByRole("button", { name: "Ask agent instead" }),
			),
		);
		expect(getAgentComposers()).toMatchObject([
			{ clientId: "a1", text: "first" },
			{ span: LINE, text: "second thought" },
		]);
		// The first lands (its composer closes); the second's text stays.
		act(() => land(new Response(JSON.stringify(conversation({ id: "N1" })))));
		await vi.waitFor(() => expect(getAgentComposers()).toHaveLength(1));
		expect(getAgentComposers()).toMatchObject([
			{ span: LINE, text: "second thought" },
		]);
	});

	it("is off until the overview is known", () => {
		show(LINE, "x", { noOverview: true });
		const button = screen.getByRole("button", { name: "Ask agent instead" });
		expect(button.getAttribute("aria-disabled")).toBe("true");
	});

	it.each([
		["a line comment", LINE],
		["a file comment", FILE],
	])(
		"on %s moves the text to an Ask agent composer on the span",
		(_n, span) => {
			const confirm = vi.spyOn(window, "confirm");
			const { writer, id } = show(span, "why <b>this</b>?");
			const button = screen.getByRole("button", { name: "Ask agent instead" });
			expect(button.getAttribute("aria-disabled")).toBeNull();
			act(() => fireEvent.click(button));
			expect(confirm).not.toHaveBeenCalled();
			// The comment composer and its draft are gone.
			expect(getComposers()).toEqual([]);
			expect(writer.drafts.newThread(id)).toBeUndefined();
			expect(screen.queryByTestId("new-thread")).toBeNull();
			// The agent's, on the same span, with the text as plain text.
			expect(getAgentComposers()).toMatchObject([
				{ span, text: "why <b>this</b>?" },
			]);
			const box = screen.getByRole("textbox", { name: "Ask your agent" });
			expect(box).toHaveValue("why <b>this</b>?");
			expect(document.activeElement).toBe(box);
			expect(
				screen.getByTestId("agent-composer").querySelector("b"),
			).toBeNull();
		},
	);

	it("switches with nothing typed", () => {
		show(LINE, "");
		act(() =>
			fireEvent.click(
				screen.getByRole("button", { name: "Ask agent instead" }),
			),
		);
		expect(getComposers()).toEqual([]);
		expect(getAgentComposers()).toMatchObject([{ span: LINE, text: "" }]);
	});

	it.each<[string, Parameters<typeof show>[2], CodeSpan, string]>([
		[
			"as of a cutoff",
			{ writes: "as-of" },
			LINE,
			"Your agent is off as of a cutoff",
		],
		[
			"as someone else",
			{ writes: "viewer" },
			FILE,
			"Your agent is off when viewing as someone else",
		],
		[
			"while the head is unsure",
			{ headUnsure: true },
			LINE,
			"The new head's diff is loading",
		],
	])("is disabled with the reason %s", (_n, opts, span, why) => {
		show(span, "kept", opts);
		const button = screen.getByRole("button", { name: "Ask agent instead" });
		expect(button.getAttribute("aria-disabled")).toBe("true");
		act(() => fireEvent.focus(button));
		expect(screen.getByRole("tooltip")).toHaveTextContent(why);
		act(() => fireEvent.click(button));
		expect(getAgentComposers()).toEqual([]);
		expect(screen.getByTestId("new-thread")).toBeTruthy();
	});

	it("takes a file comment while the head is unsure", () => {
		show(FILE, "x", { headUnsure: true });
		const button = screen.getByRole("button", { name: "Ask agent instead" });
		expect(button.getAttribute("aria-disabled")).toBeNull();
	});
});

/** An Ask agent composer on the span with `text` typed, and the comment composers it may open. */
function showAsking(
	span: CodeSpan,
	text: string,
	opts: {
		writes?: PrOverview["writes"];
		commentLeft?: boolean;
		comment?: AgentCommentContext;
		noOverview?: boolean;
		/** A comment draft on the span already (restored from a reload). */
		draft?: string;
	} = {},
) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: Infinity } },
	});
	if (!opts.noOverview) {
		client.setQueryData(overviewQuery.queryKey, {
			writes: opts.writes ?? "on",
			commentLeft: opts.commentLeft ?? true,
		} as PrOverview);
	}
	const writer = threadWritesFor(client);
	if (opts.draft) writer.drafts.setNew("d1", targetOf(span), opts.draft);
	openAgentComposer(span, "aid1", text);
	function Page() {
		const asking = useAgentComposers();
		const items = newThreadItems(useDrafts(), useComposers());
		return (
			<>
				{asking.map((c) => (
					<AgentComposer
						key={c.clientId}
						clientId={c.clientId}
						span={c.span}
						quote="q"
						comment={opts.comment}
					/>
				))}
				{items.map((item) => (
					<NewThread key={item.clientId} item={item} quote="q" />
				))}
			</>
		);
	}
	render(
		<QueryClientProvider client={client}>
			<Page />
		</QueryClientProvider>,
	);
	return { writer };
}

describe("AgentComposer's comment button", () => {
	it("knows a question's head: the shown one, an earlier one, or not yet", () => {
		expect(headFacts(LINE, "head1")).toEqual({ stale: false });
		expect(headFacts(LINE, "head0")).toEqual({ stale: true });
		expect(headFacts(FILE, "")).toEqual({ loading: true });
		expect(headFacts(FILE, undefined)).toEqual({ loading: true });
	});

	it("says it is loading while the head is unknown", () => {
		showAsking(FILE, "x", { comment: { loading: true } });
		const button = screen.getByRole("button", { name: "Comment instead" });
		expect(button.getAttribute("aria-disabled")).toBe("true");
		act(() => fireEvent.focus(button));
		expect(screen.getByRole("tooltip")).toHaveTextContent("Loading the PR");
	});

	it("joins a comment draft already on the span: one card", () => {
		const { writer } = showAsking(LINE, "and this", { draft: "kept" });
		expect(screen.getAllByTestId("new-thread")).toHaveLength(1);
		act(() =>
			fireEvent.click(screen.getByRole("button", { name: "Comment instead" })),
		);
		expect(screen.getAllByTestId("new-thread")).toHaveLength(1);
		expect(writer.drafts.newThread("d1")?.text).toBe("kept\n\nand this");
		expect(
			writer.drafts.get().filter((d) => d.create !== undefined),
		).toHaveLength(1);
		expect(screen.getByRole("textbox", { name: "Comment" })).toHaveValue(
			"kept\n\nand this",
		);
	});

	it("is off until the overview is known", () => {
		showAsking(LINE, "x", { noOverview: true });
		const button = screen.getByRole("button", { name: "Comment instead" });
		expect(button.getAttribute("aria-disabled")).toBe("true");
	});

	it.each([
		["a line", LINE],
		["a file", FILE],
	])(
		"on %s moves the question to a comment composer on the span",
		(_n, span) => {
			const confirm = vi.spyOn(window, "confirm");
			const { writer } = showAsking(span, "why <b>this</b>?");
			const button = screen.getByRole("button", { name: "Comment instead" });
			expect(button.getAttribute("aria-disabled")).toBeNull();
			act(() => fireEvent.click(button));
			expect(confirm).not.toHaveBeenCalled();
			expect(getAgentComposers()).toEqual([]);
			expect(screen.queryByTestId("agent-composer")).toBeNull();
			const [opened] = getComposers();
			expect(opened?.span).toEqual(span);
			// A draft from the start (kept across a reload), not posted.
			const draft = opened && writer.drafts.newThread(opened.clientId);
			expect(draft?.text).toBe("why <b>this</b>?");
			expect(draft?.create?.sending).toBeUndefined();
			const box = screen.getByRole("textbox", { name: "Comment" });
			expect(box).toHaveValue("why <b>this</b>?");
			expect(document.activeElement).toBe(box);
			expect(screen.getByTestId("new-thread").querySelector("b")).toBeNull();
		},
	);

	it("goes there and back with the text", () => {
		showAsking(LINE, "round trip");
		act(() =>
			fireEvent.click(screen.getByRole("button", { name: "Comment instead" })),
		);
		act(() =>
			fireEvent.click(
				screen.getByRole("button", { name: "Ask agent instead" }),
			),
		);
		expect(getComposers()).toEqual([]);
		expect(screen.queryByTestId("new-thread")).toBeNull();
		expect(getAgentComposers()).toMatchObject([
			{ span: LINE, text: "round trip" },
		]);
	});

	it.each<[string, Parameters<typeof showAsking>[2], CodeSpan, string]>([
		[
			"as of a cutoff",
			{ writes: "as-of" },
			LINE,
			"Comments are off as of a cutoff",
		],
		[
			"as someone else",
			{ writes: "viewer" },
			FILE,
			"Comments are off when viewing as someone else",
		],
		[
			"on an earlier patch set",
			{ comment: { readOnly: true } },
			FILE,
			"An earlier patch set: comment on the latest",
		],
		[
			"while the head is unsure",
			{ comment: { headUnsure: true } },
			LINE,
			"The new head's diff is loading",
		],
		[
			"on expanded context",
			{ comment: { inDiff: false } },
			LINE,
			"GitHub only takes comments on lines in the diff",
		],
		[
			"in a binary file",
			{ comment: { file: { binary: true, submodule: false } } },
			LINE,
			"No lines to comment on in this file",
		],
		[
			"asked on an earlier head",
			{ comment: { stale: true } },
			LINE,
			"Asked on an earlier head",
		],
		[
			"on old lines with a pinned head",
			{ commentLeft: false },
			{ ...LINE, startSide: "LEFT" },
			"Old lines can't take comments with this pinned head",
		],
	])("is disabled with the reason %s", (_n, opts, span, why) => {
		showAsking(span, "kept", opts);
		const button = screen.getByRole("button", { name: "Comment instead" });
		expect(button.getAttribute("aria-disabled")).toBe("true");
		act(() => fireEvent.focus(button));
		expect(screen.getByRole("tooltip")).toHaveTextContent(why);
		act(() => fireEvent.click(button));
		expect(getComposers()).toEqual([]);
		expect(getAgentComposers()).toHaveLength(1);
	});
});
