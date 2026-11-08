// @vitest-environment jsdom
import type { QueryClient } from "@tanstack/react-query";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { type ReactNode, useEffect, useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { heldJson } from "../../../../test/loading";
import type { DiffLine, FileHunks, FileView } from "../../../shared/types";
import { hunksQuery } from "../../api";
import { newQueryClient } from "../../queryClient";
import { contextRanges } from "../contextRanges";
import type { Hit } from "./findInPr";
import { findState } from "./findState";
import { useFind } from "./useFind";

const file = (
	index: number,
	removed: string[],
	added: string[],
	path = `${String.fromCharCode(97 + (index % 26))}${index}.txt`,
): FileView => ({
	index,
	path,
	status: "modified",
	binary: false,
	submodule: false,
	additions: added.length,
	deletions: removed.length,
	done: false,
	reviewed: false,
	crossedOff: false,
	clusters: [
		{
			key: `k${index}`,
			kind: "lines",
			oldStart: 2,
			oldCount: removed.length,
			newStart: 2,
			newCount: added.length,
			removed,
			added,
			lines: removed.length + added.length,
			state: "unreviewed",
		},
	],
});

/** The file's hunk: `before` as a context line 1, then its changed lines at 2. */
const hunksOf = (f: FileView, before: string): FileHunks => {
	const c = f.clusters[0] as FileView["clusters"][number];
	const lines: DiffLine[] = [
		{ kind: "context", oldNo: 1, newNo: 1, text: before },
		...c.removed.map(
			(text, i): DiffLine => ({
				kind: "del",
				oldNo: 2 + i,
				text,
				clusterKey: c.key,
			}),
		),
		...c.added.map(
			(text, i): DiffLine => ({
				kind: "add",
				newNo: 2 + i,
				text,
				clusterKey: c.key,
			}),
		),
	];
	return {
		newLineCount: 1 + c.added.length,
		hunks: [
			{
				oldStart: 1,
				oldCount: 1 + c.removed.length,
				newStart: 1,
				newCount: 1 + c.added.length,
				lines,
			},
		],
	} as FileHunks;
};

interface Batch {
	revision: string;
	indexes: number[];
	held: ReturnType<typeof heldJson>;
}

let client: QueryClient;
let batches: Batch[];
/** Held per-file hunks requests, in order (`/api/files/<n>/hunks`). */
let singles: { index: number; held: ReturnType<typeof heldJson> }[];
/** Held expanded-context requests, in order (`/api/files/<n>/context`). */
let contexts: { index: number; held: ReturnType<typeof heldJson> }[];

beforeEach(() => {
	findState.reset();
	contextRanges.reset();
	client = newQueryClient();
	batches = [];
	singles = [];
	contexts = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL) => {
			const url = new URL(String(input), "http://test");
			if (url.pathname === "/api/files/hunks") {
				const held = heldJson();
				batches.push({
					revision: url.searchParams.get("revision") ?? "",
					indexes: (url.searchParams.get("indexes") ?? "")
						.split(",")
						.map(Number),
					held,
				});
				return held.response;
			}
			const single = /^\/api\/files\/(\d+)\/hunks$/.exec(url.pathname);
			if (single) {
				const held = heldJson();
				singles.push({ index: Number(single[1]), held });
				return held.response;
			}
			const ctx = /^\/api\/files\/(\d+)\/context$/.exec(url.pathname);
			if (ctx) {
				const held = heldJson();
				contexts.push({ index: Number(ctx[1]), held });
				return held.response;
			}
			return new Response("{}", { status: 404 });
		}),
	);
});
afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

function renderFind(props: {
	revision: string;
	files: FileView[];
	openIndex: number | null;
	onStale?: () => Promise<string | undefined>;
}) {
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
	return renderHook((p: typeof props) => useFind({ ...p, active: true }), {
		wrapper,
		initialProps: props,
	});
}

const search = (term: string) =>
	act(() => {
		findState.open();
		findState.setTerm(term);
	});

describe("useFind", () => {
	it("searches paths and changed lines at once and counts context once the prefetch lands", async () => {
		const files = [file(0, ["old"], ["save it"]), file(1, ["x"], ["y"])];
		const { result } = renderFind({ revision: "r1", files, openIndex: null });
		search("save");
		await waitFor(() => expect(batches).toHaveLength(1));
		expect(result.current.count?.of).toBe(1);
		expect(result.current.searching).toBe(true);
		await act(async () => {
			batches[0]?.held.release({
				files: [
					{ index: 0, hunks: hunksOf(files[0] as FileView, "ctx") },
					{ index: 1, hunks: hunksOf(files[1] as FileView, "save me") },
				],
			});
		});
		await waitFor(() => expect(result.current.count?.of).toBe(2));
		expect(result.current.searching).toBe(false);
		expect(result.current.failed).toBe(0);
	});

	it("the caret after typing is the open file's first hit, unshown; a step shows it, the next moves", async () => {
		const files = [file(0, [], ["save"]), file(1, [], ["a save b save"])];
		const { result } = renderFind({ revision: "r1", files, openIndex: 1 });
		search("save");
		const caret = result.current.caret;
		expect(caret?.pos).toEqual({ index: 1, side: "RIGHT", line: 2, col: 2 });
		expect(caret?.shown).toBe(false);
		expect(result.current.count).toEqual({ at: 2, of: 3 });
		let hit: ReturnType<typeof result.current.step> = null;
		act(() => {
			hit = result.current.step(1);
		});
		expect(hit).toMatchObject({ index: 1, line: 2, col: 2 });
		expect(result.current.caret).toEqual({ pos: caret?.pos, shown: true });
		expect(result.current.count).toEqual({ at: 2, of: 3 });
		act(() => {
			result.current.step(1);
		});
		expect(result.current.caret?.pos).toEqual({
			index: 1,
			side: "RIGHT",
			line: 2,
			col: 9,
		});
		expect(result.current.count).toEqual({ at: 3, of: 3 });
		// The marks on the open file's line: the current one painted so.
		expect(result.current.diffOf(1)?.marksOf("RIGHT", 2)).toEqual([
			{ from: 2, to: 6, current: false },
			{ from: 9, to: 13, current: true },
		]);
		expect(result.current.diffOf(1)?.current).toEqual({
			old: false,
			line: 2,
		});
	});

	it("the first step after typing moves on when the caret's hit is already seen, and goes to it when not", () => {
		const files = [file(0, [], ["save"]), file(1, [], ["a save b save"])];
		const { result } = renderFind({ revision: "r1", files, openIndex: 1 });
		search("save");
		const caret = result.current.caret;
		expect(caret?.pos).toMatchObject({ index: 1, col: 2 });
		const asked: unknown[] = [];
		let hit: ReturnType<typeof result.current.step> = null;
		act(() => {
			hit = result.current.step(1, (h) => {
				asked.push(h);
				return true;
			});
		});
		// Asked about the caret's own hit, which is seen: on to the next.
		expect(asked).toEqual([expect.objectContaining({ index: 1, col: 2 })]);
		expect(hit).toMatchObject({ index: 1, col: 9 });
		expect(result.current.count).toEqual({ at: 3, of: 3 });

		// Typing again: unseen, the first Shift+Enter goes to the caret itself.
		act(() => findState.setTerm("sav"));
		act(() => {
			hit = result.current.step(-1, () => false);
		});
		expect(hit).toMatchObject({ index: 1, col: 2 });
		// Seen and stepping back: the hit before it.
		act(() => findState.setTerm("save"));
		act(() => {
			hit = result.current.step(-1, () => true);
		});
		expect(hit).toMatchObject({ index: 0, col: 0 });
		// A shown caret isn't asked about.
		const again = vi.fn(() => true);
		act(() => {
			hit = result.current.step(1, again);
		});
		expect(again).not.toHaveBeenCalled();
		expect(hit).toMatchObject({ index: 1, col: 2 });
	});

	it("a file opened after typing doesn't move the caret; typing again starts from it", () => {
		const files = [file(0, [], ["save"]), file(1, [], ["save"])];
		const { result, rerender } = renderFind({
			revision: "r1",
			files,
			openIndex: 1,
		});
		search("sav");
		expect(result.current.caret?.pos.index).toBe(1);
		rerender({ revision: "r1", files, openIndex: 0 });
		expect(result.current.caret?.pos.index).toBe(1);
		act(() => findState.setTerm("save"));
		expect(result.current.caret?.pos.index).toBe(0);
	});

	it("keeps the caret on the same characters when hits arrive before it", async () => {
		const files = [file(0, [], ["save"]), file(1, [], ["y"])];
		const { result } = renderFind({ revision: "r1", files, openIndex: 0 });
		search("save");
		act(() => {
			result.current.step(1);
		});
		const pos = result.current.caret?.pos;
		expect(pos).toEqual({ index: 0, side: "RIGHT", line: 2, col: 0 });
		expect(result.current.count).toEqual({ at: 1, of: 1 });
		await waitFor(() => expect(batches).toHaveLength(1));
		await act(async () => {
			batches[0]?.held.release({
				files: [
					{ index: 0, hunks: hunksOf(files[0] as FileView, "save first") },
					{ index: 1, hunks: hunksOf(files[1] as FileView, "z") },
				],
			});
		});
		await waitFor(() => expect(result.current.count).toEqual({ at: 2, of: 2 }));
		expect(result.current.caret).toEqual({ pos, shown: true });
	});

	it("restarts the prefetch for a new revision and stops it on close", async () => {
		// More files than two batches: a third waits its turn.
		const files = Array.from({ length: 60 }, (_, i) => file(i, [], ["y"]));
		const { result, rerender } = renderFind({
			revision: "r1",
			files,
			openIndex: null,
		});
		search("save");
		await waitFor(() => expect(batches).toHaveLength(2));
		rerender({ revision: "r2", files, openIndex: null });
		await waitFor(() => expect(batches).toHaveLength(4));
		expect(batches.slice(2).map((b) => b.revision)).toEqual(["r2", "r2"]);
		await act(async () => {
			batches[0]?.held.release({ error: "stale" }, 409);
			batches[1]?.held.release({ error: "stale" }, 409);
		});
		expect(result.current.failed).toBe(0);
		expect(result.current.searching).toBe(true);
		act(() => findState.close());
		const answer = (b: Batch | undefined) => ({
			files: (b?.indexes ?? []).map((index) => ({
				index,
				hunks: hunksOf(files[index] as FileView, ""),
			})),
		});
		await act(async () => {
			batches[2]?.held.release(answer(batches[2]));
			batches[3]?.held.release(answer(batches[3]));
		});
		// Give a request that shouldn't come every chance to.
		await act(() => new Promise((r) => setTimeout(r, 20)));
		expect(batches).toHaveLength(4);
		expect(result.current.searching).toBe(false);
	});

	it("a 409 keeps searching, counts nothing failed and asks the page to read the review again", async () => {
		const files = [file(0, [], ["save"]), file(1, [], ["y"])];
		// The page's read of the review, still out.
		const onStale = vi.fn(() => new Promise<string | undefined>(() => {}));
		const { result } = renderFind({
			revision: "r1",
			files,
			openIndex: null,
			onStale,
		});
		search("save");
		await waitFor(() => expect(batches).toHaveLength(1));
		await act(async () => {
			batches[0]?.held.release({ error: "stale" }, 409);
		});
		await waitFor(() => expect(onStale).toHaveBeenCalledTimes(1));
		expect(result.current.searching).toBe(true);
		expect(result.current.failed).toBe(0);
	});

	it.each([
		["comes back on the same revision", () => Promise.resolve("r1")],
		["fails", () => Promise.reject(new Error("down"))],
	])(
		"after a 409, when the review read %s, the files count as failed and Retry asks again",
		async (_, answer) => {
			const files = [file(0, [], ["save"]), file(1, [], ["y"])];
			const onStale = vi.fn(answer);
			const { result } = renderFind({
				revision: "r1",
				files,
				openIndex: null,
				onStale,
			});
			search("save");
			await waitFor(() => expect(batches).toHaveLength(1));
			await act(async () => {
				batches[0]?.held.release({ error: "stale" }, 409);
			});
			await waitFor(() => expect(result.current.failed).toBe(2));
			expect(result.current.searching).toBe(false);
			act(() => result.current.retry());
			await waitFor(() => expect(batches).toHaveLength(2));
			expect(batches[1]?.indexes).toEqual([0, 1]);
			expect(result.current.searching).toBe(true);
		},
	);

	it("searching from the first render of a new revision (the old prefetch, done, never counts)", async () => {
		const files = [file(0, [], ["save"])];
		const seen: { revision: string; searching: boolean }[] = [];
		const { result, rerender } = renderHook(
			(p: { revision: string }) => {
				const f = useFind({
					revision: p.revision,
					files,
					openIndex: null,
					active: true,
				});
				seen.push({ revision: p.revision, searching: f.searching });
				return f;
			},
			{
				wrapper: ({ children }: { children: ReactNode }) => (
					<QueryClientProvider client={client}>{children}</QueryClientProvider>
				),
				initialProps: { revision: "r1" },
			},
		);
		search("save");
		await waitFor(() => expect(batches).toHaveLength(1));
		await act(async () => {
			batches[0]?.held.release({
				files: [{ index: 0, hunks: hunksOf(files[0] as FileView, "z") }],
			});
		});
		await waitFor(() => expect(result.current.searching).toBe(false));
		seen.length = 0;
		rerender({ revision: "r2" });
		expect(seen.length).toBeGreaterThan(0);
		expect(seen.every((r) => r.searching)).toBe(true);
	});

	it("searches the typed term deferred, and keeps searching while the results trail it", async () => {
		const files = [file(0, [], ["ab", "abc"], "zz.txt")];
		const seen: { typed: string; of: number; searching: boolean }[] = [];
		renderHook(
			() => {
				const f = useFind({
					revision: "r1",
					files,
					openIndex: null,
					active: true,
				});
				seen.push({
					typed: f.state.term,
					of: f.count?.of ?? -1,
					searching: f.searching,
				});
				return f;
			},
			{
				wrapper: ({ children }: { children: ReactNode }) => (
					<QueryClientProvider client={client}>{children}</QueryClientProvider>
				),
			},
		);
		search("ab");
		await waitFor(() => expect(batches).toHaveLength(1));
		await act(async () => {
			batches[0]?.held.release({
				files: [{ index: 0, hunks: hunksOf(files[0] as FileView, "z") }],
			});
		});
		await waitFor(() => expect(seen.at(-1)?.searching).toBe(false));
		expect(seen.at(-1)?.of).toBe(2);
		seen.length = 0;
		act(() => findState.setTerm("abc"));
		expect(seen.at(-1)).toEqual({ typed: "abc", of: 1, searching: false });
		// A render for the new term with the old term's results came first
		// (typing stays responsive), and it showed the spinner.
		const trailing = seen.filter((r) => r.typed === "abc" && r.of === 2);
		expect(trailing.length).toBeGreaterThan(0);
		expect(trailing.every((r) => r.searching)).toBe(true);
	});

	it("a step while the results trail the typed term steps through the typed term's hits", async () => {
		const files = [
			file(0, [], ["ab"], "zz.txt"),
			file(1, [], ["abc"], "yy.txt"),
		];
		const steps: (Hit | null)[] = [];
		const { result } = renderHook(
			() => {
				const f = useFind({
					revision: "r1",
					files,
					openIndex: null,
					active: true,
				});
				const fired = useRef(false);
				// Enter right after typing: between the keystroke's render and
				// the deferred search's.
				useEffect(() => {
					if (f.state.term !== "abc" || !f.searching || fired.current) return;
					fired.current = true;
					steps.push(f.step(1));
				});
				return f;
			},
			{
				wrapper: ({ children }: { children: ReactNode }) => (
					<QueryClientProvider client={client}>{children}</QueryClientProvider>
				),
			},
		);
		search("ab");
		await waitFor(() => expect(batches).toHaveLength(1));
		await act(async () => {
			batches[0]?.held.release({
				files: files.map((f) => ({ index: f.index, hunks: hunksOf(f, "z") })),
			});
		});
		await waitFor(() => expect(result.current.searching).toBe(false));
		act(() => findState.setTerm("abc"));
		expect(steps).toHaveLength(1);
		expect(steps[0]).toMatchObject({
			index: 1,
			side: "RIGHT",
			line: 2,
			col: 0,
		});
		await waitFor(() => expect(result.current.searching).toBe(false));
		expect(result.current.caret).toEqual({
			pos: { index: 1, side: "RIGHT", line: 2, col: 0 },
			shown: true,
		});
		expect(result.current.count).toEqual({ at: 1, of: 1 });
	});

	it("keeps a file's DiffFind the same object while its hits and caret don't change", async () => {
		const files = [file(0, [], ["save"]), file(1, [], ["y"])];
		const { result } = renderFind({ revision: "r1", files, openIndex: 0 });
		search("save");
		const before = result.current.diffOf(0);
		expect(before?.current).toEqual({ old: false, line: 2 });
		await waitFor(() => expect(batches).toHaveLength(1));
		await act(async () => {
			batches[0]?.held.release({
				files: [
					{ index: 0, hunks: hunksOf(files[0] as FileView, "z") },
					{ index: 1, hunks: hunksOf(files[1] as FileView, "save") },
				],
			});
		});
		await waitFor(() => expect(result.current.count?.of).toBe(2));
		expect(result.current.diffOf(0)).toBe(before);
		expect(result.current.diffOf(1)?.marksOf("RIGHT", 1)).toHaveLength(1);
	});

	it("reports failed batches and asks again on retry", async () => {
		const files = [file(0, [], ["save"]), file(1, [], ["y"])];
		const { result } = renderFind({ revision: "r1", files, openIndex: null });
		search("save");
		await waitFor(() => expect(batches).toHaveLength(1));
		await act(async () => {
			batches[0]?.held.release({ error: "boom" }, 500);
		});
		await waitFor(() => expect(result.current.failed).toBe(2));
		expect(result.current.count).toEqual({ at: 1, of: 1 });
		expect(result.current.searching).toBe(false);
		act(() => result.current.retry());
		await waitFor(() => expect(batches).toHaveLength(2));
		expect(batches[1]?.indexes).toEqual([0, 1]);
		expect(result.current.failed).toBe(0);
		expect(result.current.searching).toBe(true);
	});
	it("a file the prefetch failed that its own request then answered (opened) no longer counts as failed", async () => {
		const files = [file(0, [], ["save"]), file(1, [], ["y"])];
		const { result } = renderFind({ revision: "r1", files, openIndex: null });
		search("save");
		await waitFor(() => expect(batches).toHaveLength(1));
		await act(async () => {
			batches[0]?.held.release({ error: "boom" }, 500);
		});
		await waitFor(() => expect(result.current.failed).toBe(2));
		// The reviewer opens file 0: its diff asks for its hunks.
		void client.prefetchQuery(hunksQuery("r1", 0));
		await waitFor(() => expect(singles).toHaveLength(1));
		await act(async () => {
			singles[0]?.held.release(hunksOf(files[0] as FileView, "save it"));
		});
		await waitFor(() => expect(result.current.count?.of).toBe(2));
		expect(result.current.failed).toBe(1);
	});

	it("fetches an expanded range that isn't loaded (dropped while the bar was closed), searching until it lands", async () => {
		const files = [file(0, [], ["y"])];
		// The file was expanded earlier; its lines have since been dropped.
		contextRanges.add("r1", 0, 10, 12);
		const { result } = renderFind({ revision: "r1", files, openIndex: null });
		search("save");
		await waitFor(() => expect(contexts).toHaveLength(1));
		await waitFor(() => expect(batches).toHaveLength(1));
		await act(async () => {
			batches[0]?.held.release({
				files: [{ index: 0, hunks: hunksOf(files[0] as FileView, "z") }],
			});
		});
		// Give the prefetch's answer every chance to land.
		await act(() => new Promise((r) => setTimeout(r, 20)));
		expect(result.current.searching).toBe(true);
		await act(async () => {
			contexts[0]?.held.release([
				{ kind: "context", oldNo: 10, newNo: 10, text: "save here" },
			]);
		});
		await waitFor(() => expect(result.current.searching).toBe(false));
		expect(result.current.count?.of).toBe(1);
		expect(result.current.failed).toBe(0);
	});

	it("counts a file whose expanded range failed, and asks again on retry", async () => {
		const files = [file(0, [], ["y"])];
		contextRanges.add("r1", 0, 10, 12);
		const { result } = renderFind({ revision: "r1", files, openIndex: null });
		search("save");
		await waitFor(() => expect(contexts).toHaveLength(1));
		await waitFor(() => expect(batches).toHaveLength(1));
		await act(async () => {
			batches[0]?.held.release({
				files: [{ index: 0, hunks: hunksOf(files[0] as FileView, "z") }],
			});
			contexts[0]?.held.release({ error: "boom" }, 500);
		});
		await waitFor(() => expect(result.current.failed).toBe(1));
		expect(result.current.searching).toBe(false);
		act(() => result.current.retry());
		await waitFor(() => expect(contexts).toHaveLength(2));
		expect(result.current.searching).toBe(true);
		await act(async () => {
			contexts[1]?.held.release([
				{ kind: "context", oldNo: 10, newNo: 10, text: "save here" },
			]);
		});
		await waitFor(() => expect(result.current.failed).toBe(0));
		expect(result.current.searching).toBe(false);
		expect(result.current.count?.of).toBe(1);
	});

	it("keeps searching while the open file's own hunks are still on their way", async () => {
		const files = [file(0, [], ["save"]), file(1, [], ["y"])];
		// The open file's diff asked for its hunks before the bar opened.
		void client.prefetchQuery(hunksQuery("r1", 0));
		await waitFor(() => expect(singles).toHaveLength(1));
		const { result } = renderFind({ revision: "r1", files, openIndex: 0 });
		search("save");
		await waitFor(() => expect(batches).toHaveLength(1));
		// The prefetch leaves the file being fetched to its own request.
		expect(batches[0]?.indexes).toEqual([1]);
		expect(result.current.searching).toBe(true);
		await act(async () => {
			batches[0]?.held.release({
				files: [{ index: 1, hunks: hunksOf(files[1] as FileView, "z") }],
			});
		});
		// Give the prefetch's answer every chance to land.
		await act(() => new Promise((r) => setTimeout(r, 20)));
		expect(result.current.searching).toBe(true);
		await act(async () => {
			singles[0]?.held.release(hunksOf(files[0] as FileView, "save too"));
		});
		await waitFor(() => expect(result.current.searching).toBe(false));
		expect(result.current.count?.of).toBe(2);
	});

	it("counts the open file whose own hunks request failed, and asks again on retry", async () => {
		const files = [file(0, [], ["save"]), file(1, [], ["y"])];
		void client.prefetchQuery(hunksQuery("r1", 0));
		await waitFor(() => expect(singles).toHaveLength(1));
		const { result } = renderFind({ revision: "r1", files, openIndex: 0 });
		search("save");
		await waitFor(() => expect(batches).toHaveLength(1));
		await act(async () => {
			batches[0]?.held.release({
				files: [{ index: 1, hunks: hunksOf(files[1] as FileView, "z") }],
			});
			singles[0]?.held.release({ error: "boom" }, 500);
		});
		await waitFor(() => expect(result.current.failed).toBe(1));
		expect(result.current.searching).toBe(false);
		// Only while there's a term.
		act(() => findState.setTerm(""));
		expect(result.current.failed).toBe(0);
		act(() => findState.setTerm("save"));
		expect(result.current.failed).toBe(1);
		act(() => result.current.retry());
		await waitFor(() => expect(batches).toHaveLength(2));
		expect(batches[1]?.indexes).toEqual([0]);
		expect(result.current.searching).toBe(true);
		await act(async () => {
			batches[1]?.held.release({
				files: [{ index: 0, hunks: hunksOf(files[0] as FileView, "save") }],
			});
		});
		await waitFor(() => expect(result.current.failed).toBe(0));
		expect(result.current.searching).toBe(false);
		expect(result.current.count?.of).toBe(2);
	});

	it("shows searching from the first render of a reopened bar with a kept term", () => {
		const files = [file(0, [], ["save"])];
		const { result } = renderFind({ revision: "r1", files, openIndex: null });
		act(() => findState.setTerm("save"));
		const seen: { counted: boolean; searching: boolean }[] = [];
		const { result: again } = renderHook(
			() => {
				const f = useFind({
					revision: "r1",
					files,
					openIndex: null,
					active: true,
				});
				seen.push({ counted: f.count !== null, searching: f.searching });
				return f;
			},
			{
				wrapper: ({ children }: { children: ReactNode }) => (
					<QueryClientProvider client={client}>{children}</QueryClientProvider>
				),
			},
		);
		expect(result.current.count).toBeNull();
		act(() => findState.open());
		expect(again.current.count?.of).toBe(1);
		// No render with a count and no spinner while the prefetch starts.
		const counted = seen.filter((r) => r.counted);
		expect(counted.length).toBeGreaterThan(0);
		expect(counted.every((r) => r.searching)).toBe(true);
	});
});
