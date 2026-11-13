import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import githubMarks from "../../../test/fixtures/inline-diff/github-marks.json" with {
	type: "json",
};
import knownDifferences from "../../../test/fixtures/inline-diff/known-differences.json" with {
	type: "json",
};
import {
	createGitFixture,
	GIT_TEST_TIMEOUTS,
	type GitFixture,
} from "../../../test/git-fixture";
import { buildSnapshot, loadFileHunks } from "../../server/diff/snapshot";
import type { DiffLine, DisplayHunk } from "../../shared/types";
import type { Mark } from "../code/Invisibles";
import { hunkView } from "./whitespace";
import { pairWordMarks } from "./wordBlocks";

/**
 * Carbonless's marks against GitHub's, on the gallery's inline-diff case
 * (Gilthans/carbonless-gallery#14, our playground; rebuilt by
 * scripts/inline-diff-fixtures.mjs). The case files go through carbonless's
 * own diff, as the server serves them, then the view's rows and their
 * marks (pairWordMarks of hunkView's pairs). Every difference from
 * GitHub's observed marks is listed in known-differences.json with its
 * reason. The list may only shrink, except by
 * an owner decision: dated and quoted in the entry's reason, and recorded in
 * the spec's "Decided by the owner" (2026-11-04 grew it from 5 to 23; the
 * same day's bridging of spaces between two changes shrank it to 8; step 2's
 * similarity pairing of unequal clusters, 2026-11-08, grew it by 12: lines of
 * unequal blocks GitHub leaves plain now get marks).
 */

// Real git processes: see GIT_TEST_TIMEOUTS.
vi.setConfig(GIT_TEST_TIMEOUTS);

const DIR = fileURLToPath(
	new URL("../../../test/fixtures/inline-diff/", import.meta.url),
);
const read = (path: string) => readFileSync(`${DIR}${path}`, "utf8");

interface GitHubPair {
	old: string;
	new: string;
	oldMarks: Mark[];
	newMarks: Mark[];
}
interface GitHubBlock {
	shape: string;
	pairs: GitHubPair[];
	removed?: { text: string; marks: Mark[] }[];
	added?: { text: string; marks: Mark[] }[];
}
interface GitHubFile {
	blocks: GitHubBlock[];
	hiddenWithIgnoreWhitespace?: boolean;
}
interface Known {
	file: string;
	/** A pair's index in the file, `line <i>` for a line of an unequal block, or `shape`. */
	pair: number | string;
	/** The setting the difference shows under; both when absent. */
	ignoreWhitespace?: boolean;
	/** Our marks of the pair's lines, pinned: a change to them fails too. */
	ours?: Ours;
	reason: string;
}
/** Our marks of a unit's removed line and added line (absent sides: none). */
interface Ours {
	old?: Mark[];
	new?: Mark[];
}
interface Mismatch {
	file: string;
	pair: number | string;
	ignoreWhitespace: boolean;
	ours?: Ours;
	detail: string;
}

// Imported, not read, so vitest's changed-file graph runs this test when
// only the data changes.
const github = githubMarks as unknown as { files: Record<string, GitHubFile> };
const known = knownDifferences as unknown as Known[];
const paths = Object.keys(github.files);

/** A changed line as GitHub shows it, with the unit it belongs to. */
interface Line {
	kind: "del" | "add";
	text: string;
	marks: readonly Mark[];
	unit: number | string;
}

function githubLines(file: GitHubFile, ignoreWhitespace: boolean): Line[] {
	const lines: Line[] = [];
	let pair = 0;
	const hidden = ignoreWhitespace && file.hiddenWithIgnoreWhitespace === true;
	const marks = (m: Mark[]) => (hidden ? [] : m);
	for (const block of file.blocks) {
		if (block.removed || block.added) {
			for (const r of block.removed ?? []) {
				lines.push({
					kind: "del",
					text: r.text,
					marks: marks(r.marks),
					unit: "",
				});
			}
			for (const a of block.added ?? []) {
				lines.push({
					kind: "add",
					text: a.text,
					marks: marks(a.marks),
					unit: "",
				});
			}
			continue;
		}
		const at = pair;
		block.pairs.forEach((p, i) => {
			lines.push({
				kind: "del",
				text: p.old,
				marks: marks(p.oldMarks),
				unit: at + i,
			});
		});
		block.pairs.forEach((p, i) => {
			lines.push({
				kind: "add",
				text: p.new,
				marks: marks(p.newMarks),
				unit: at + i,
			});
		});
		pair += block.pairs.length;
	}
	lines.forEach((l, i) => {
		if (l.unit === "") l.unit = `line ${i}`;
	});
	return lines;
}

function ourLines(
	hunks: DisplayHunk[],
	ignoreWhitespace: boolean,
): { line: DiffLine; marks: readonly Mark[] }[] {
	return hunks.flatMap((hunk) => {
		const marks = pairWordMarks(hunkView(hunk.lines, ignoreWhitespace).pairs);
		return hunk.lines
			.filter((l) => l.kind !== "context")
			.map((line) => ({ line, marks: marks.get(line) ?? [] }));
	});
}

const show = (text: string, marks: readonly Mark[]) => {
	let out = "";
	let at = 0;
	for (const [from, to] of marks) {
		out += `${text.slice(at, from)}[${text.slice(from, to)}]`;
		at = to;
	}
	return JSON.stringify(out + text.slice(at));
};

function compare(
	file: string,
	hunks: DisplayHunk[],
	ignoreWhitespace: boolean,
): Mismatch[] {
	const theirs = githubLines(
		github.files[file] as GitHubFile,
		ignoreWhitespace,
	);
	const ours = ourLines(hunks, ignoreWhitespace);
	const same =
		theirs.length === ours.length &&
		theirs.every(
			(t, i) => t.kind === ours[i]?.line.kind && t.text === ours[i]?.line.text,
		);
	if (!same) {
		const describe = (xs: { kind: string; text: string }[]) =>
			xs.map((x) => `${x.kind === "del" ? "-" : "+"}${x.text}`).join("\n");
		return [
			{
				file,
				pair: "shape",
				ignoreWhitespace,
				detail: `GitHub:\n${describe(theirs)}\nours:\n${describe(ours.map((o) => o.line))}`,
			},
		];
	}
	const out = new Map<number | string, Mismatch>();
	theirs.forEach((t, i) => {
		const o = ours[i] as (typeof ours)[number];
		if (JSON.stringify(t.marks) === JSON.stringify(o.marks)) return;
		const prev = out.get(t.unit);
		const line = `${t.kind === "del" ? "-" : "+"} GitHub ${show(t.text, t.marks)}\n  ours   ${show(t.text, o.marks)}`;
		out.set(t.unit, {
			file,
			pair: t.unit,
			ignoreWhitespace,
			detail: prev ? `${prev.detail}\n${line}` : line,
		});
	});
	for (const m of out.values()) {
		const ours_: Ours = {};
		theirs.forEach((t, i) => {
			if (t.unit !== m.pair) return;
			const marks = [...(ours[i] as (typeof ours)[number]).marks].map(
				([from, to]): Mark => [from, to],
			);
			if (t.kind === "del") ours_.old = marks;
			else ours_.new = marks;
		});
		m.ours = ours_;
	}
	return [...out.values()];
}

let fixture: GitFixture;
const hunksOf = new Map<string, DisplayHunk[]>();

beforeAll(async () => {
	fixture = createGitFixture([
		{
			message: "base",
			files: Object.fromEntries(paths.map((p) => [p, read(`base/${p}`)])),
		},
		{
			message: "case",
			files: Object.fromEntries(paths.map((p) => [p, read(`case/${p}`)])),
		},
	]);
	const [base, head] = fixture.shas as [string, string];
	const snapshot = await buildSnapshot(fixture.path, base, head);
	for (const file of snapshot.files) {
		const { hunks } = await loadFileHunks(fixture.path, snapshot, file.index);
		hunksOf.set(file.path, hunks);
	}
});

afterAll(() => fixture?.cleanup());

describe("word marks against GitHub's (gallery PR #14)", () => {
	it("has every case file", () => {
		expect(paths.length).toBe(80);
		expect([...hunksOf.keys()].sort()).toEqual([...paths].sort());
	});

	const matches = (k: Known, m: Mismatch) =>
		k.file === m.file &&
		k.pair === m.pair &&
		(k.ignoreWhitespace === undefined ||
			k.ignoreWhitespace === m.ignoreWhitespace) &&
		JSON.stringify(k.ours) === JSON.stringify(m.ours);

	it("pins our marks in every known difference but a shape one", () => {
		expect(known.filter((k) => k.pair !== "shape" && !k.ours)).toEqual([]);
	});

	it("matches GitHub but for the known differences, which grow only by an owner decision", () => {
		const mismatches = paths.flatMap((file) =>
			[false, true].flatMap((ws) => compare(file, hunksOf.get(file) ?? [], ws)),
		);
		const unlisted = mismatches.filter(
			(m) => !known.some((k) => matches(k, m)),
		);
		expect(
			unlisted.map(
				(m) =>
					`${m.file} pair ${m.pair} (ignore whitespace ${m.ignoreWhitespace ? "on" : "off"}; ours ${JSON.stringify(m.ours)})\n${m.detail}`,
			),
			"a new difference from GitHub: fix it, or list it only on an owner decision (dated, quoted in its reason)",
		).toEqual([]);
		// A listed difference must still show, in each setting it names.
		const stale = known.filter((k) =>
			(k.ignoreWhitespace === undefined
				? [false, true]
				: [k.ignoreWhitespace]
			).some(
				(ws) =>
					!mismatches.some((m) => matches(k, m) && m.ignoreWhitespace === ws),
			),
		);
		expect(
			stale,
			"now matches GitHub: remove it from known-differences.json",
		).toEqual([]);
	});
});
