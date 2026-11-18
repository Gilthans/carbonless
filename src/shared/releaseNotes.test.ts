import { describe, expect, it } from "vitest";
import {
	MAX_NOTE_CHARS,
	noneWhyProblems,
	noteSummary,
	noteTextProblems,
	parseReleaseNotesFile,
	parseShippedReleaseNotes,
	sortNotes,
} from "./releaseNotes.js";

describe("noteTextProblems", () => {
	it("accepts plain sentences, any number, with code in backticks", () => {
		expect(
			noteTextProblems(
				"Files changed has a Threads tab. Every conversation, newest first.",
			),
		).toEqual([]);
		expect(
			noteTextProblems("The `<dialog>` and `[x](y)` in code are fine."),
		).toEqual([]);
		expect(noteTextProblems("Ä capital that isn't ASCII works.")).toEqual([]);
	});

	it(`allows ${MAX_NOTE_CHARS} characters and refuses one more`, () => {
		const at = `A${"a".repeat(MAX_NOTE_CHARS - 2)}.`;
		expect(noteTextProblems(at)).toEqual([]);
		expect(noteTextProblems(`${at}a`)).toEqual([
			`is over ${MAX_NOTE_CHARS} characters`,
		]);
	});

	it.each([
		["", "is empty"],
		["   ", "is empty"],
		[" Leading space.", "has leading or trailing spaces"],
		["Two\nlines.", "has a line break, control or bidi character"],
		["A tab\there.", "has a line break, control or bidi character"],
		["Bidi ‮override.", "has a line break, control or bidi character"],
		["Isolate ⁦here.", "has a line break, control or bidi character"],
		["lowercase start.", "doesn't start with a capital letter"],
		["`code` first.", "doesn't start with a capital letter"],
		["Unpaired `tick.", "has an unpaired backtick"],
		[
			"An <img src=x onerror=alert(1)> tag.",
			"has HTML (put code in backticks)",
		],
		["A [link](https://x.y) here.", "has a link (crb adds the PR links)"],
		["Click javascript:alert(1) now.", "has a link (crb adds the PR links)"],
		["Some **bold** text.", "has markdown (only `code` is allowed)"],
		["Fixes CAR-183 for good.", "names a ticket (the tools add the ids)"],
		["Fixes car-12 too.", "names a ticket (the tools add the ids)"],
		["Landed in #110.", "names a PR (the tools add the numbers)"],
		[
			"See github.com/a/b/pull/12 there.",
			"names a PR (the tools add the numbers)",
		],
	])("refuses %j", (text, problem) => {
		expect(noteTextProblems(text)).toContain(problem);
	});

	it("doesn't take an id inside code, or an entity, for a ticket or PR", () => {
		expect(noteTextProblems("The `CAR-1` and `#2` in code are fine.")).toEqual(
			[],
		);
		expect(noteTextProblems("UTF-8 names work.")).toEqual([]);
	});
});

describe("noneWhyProblems", () => {
	it("needs a short one-line reason", () => {
		expect(noneWhyProblems("flaky test fix")).toEqual([]);
		expect(noneWhyProblems("")).toEqual([
			"is empty (say why no note is needed)",
		]);
		expect(noneWhyProblems("a\nb")).toEqual([
			"has a line break, control or bidi character",
		]);
		expect(noneWhyProblems("x".repeat(121))).toEqual([
			"is over 120 characters",
		]);
	});
});

describe("noteSummary", () => {
	it("is the first sentence, outside code", () => {
		expect(noteSummary("Threads tab. Newest first.")).toBe("Threads tab.");
		expect(noteSummary("Run `a. b` now! Then more.")).toBe("Run `a. b` now!");
		expect(noteSummary("No full stop")).toBe("No full stop");
		expect(noteSummary("Version 1.2 is out. Yes.")).toBe("Version 1.2 is out.");
	});
});

describe("sortNotes", () => {
	it("orders new, improved, fixed, then by first PR", () => {
		const n = (id: string, kind: "new" | "improved" | "fixed", pr: number) => ({
			id,
			kind,
			prs: [pr],
			text: "X.",
		});
		expect(
			sortNotes([
				n("a", "fixed", 1),
				n("b", "new", 9),
				n("c", "improved", 2),
				n("d", "new", 3),
			]).map((x) => x.id),
		).toEqual(["d", "b", "c", "a"]);
	});
});

const good = {
	version: "0.4.0",
	date: null,
	notes: [
		{
			id: "CAR-183",
			kind: "new",
			prs: [110],
			text: "Files changed has a Threads tab.",
		},
	],
	none: [{ id: "#125", prs: [125], why: "test tooling" }],
};

describe("parseReleaseNotesFile", () => {
	it("reads a valid file", () => {
		expect(parseReleaseNotesFile(good)).toEqual({ ok: true, file: good });
	});

	it("lists every problem", () => {
		const r = parseReleaseNotesFile({
			version: "0.4.0-rc.1",
			date: "yesterday",
			notes: [
				{ id: "CAR-1", kind: "huge", prs: [1], text: "X." },
				{ id: "x", kind: "new", prs: [], text: "X." },
			],
			none: [{ id: "CAR-2", prs: [-1], why: "x" }],
			extra: 1,
		});
		expect(r).toEqual({
			ok: false,
			errors: [
				"version isn't X.Y.Z",
				"date isn't YYYY-MM-DD or null",
				"notes[0] CAR-1: kind isn't new, improved or fixed",
				"notes[1] id isn't CAR-N or #N",
				"none[0] CAR-2: prs isn't a list of PR numbers",
				"unknown fields: extra",
			],
		});
		expect(parseReleaseNotesFile([])).toEqual({
			ok: false,
			errors: ["isn't a JSON object"],
		});
	});
});

describe("parseShippedReleaseNotes", () => {
	it("keeps valid entries and drops and counts bad ones", () => {
		const r = parseShippedReleaseNotes([
			{
				version: "0.5.0",
				date: null,
				uncovered: [131],
				notes: [
					{ id: "CAR-1", kind: "new", prs: [1], text: "Good one." },
					{
						id: "CAR-2",
						kind: "new",
						prs: [2],
						text: "<img src=x onerror=alert(1)>",
					},
					{ id: "CAR-3", kind: "new", prs: [3], text: "Bidi ‮." },
				],
			},
			{ version: "nope", date: null, notes: [] },
			{ version: "0.4.0", date: "2026-11-20", notes: [] },
		]);
		expect(r).toEqual({
			entries: [
				{
					version: "0.5.0",
					date: null,
					uncovered: [131],
					notes: [{ id: "CAR-1", kind: "new", prs: [1], text: "Good one." }],
				},
				{ version: "0.4.0", date: "2026-11-20", notes: [] },
			],
			dropped: 3,
		});
	});

	it("is null when there's no list", () => {
		expect(parseShippedReleaseNotes(undefined)).toBeNull();
		expect(parseShippedReleaseNotes({})).toBeNull();
	});
});
