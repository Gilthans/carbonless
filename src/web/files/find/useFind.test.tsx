// @vitest-environment jsdom
import type { QueryClient } from "@tanstack/react-query";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { heldJson } from "../../../../test/loading";
import type { DiffLine, FileHunks, FileView } from "../../../shared/types";
import { newQueryClient } from "../../queryClient";
import { contextRanges } from "../contextRanges";
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

beforeEach(() => {
	findState.reset();
	contextRanges.reset();
	client = newQueryClient();
	batches = [];
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
});
