import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { GIT_TEST_TIMEOUTS } from "../../../test/git-fixture";
import {
	aTxt,
	createRereviewHistory,
	type RereviewHistory,
} from "../../../test/rereview-fixture";
import { buildInterdiff, type Interdiff } from "./interdiff";
import { detectShape, type Endpoints } from "./shape";

// Real git processes: see GIT_TEST_TIMEOUTS.
vi.setConfig(GIT_TEST_TIMEOUTS);

const ep = (mergeBase: string, head: string): Endpoints => ({
	mergeBase,
	head,
	baseBranch: "main",
});

/** The lines of an a.txt with these changes. */
const lines = (changes: Record<number, string>) =>
	aTxt(changes).split("\n").slice(0, -1);

describe("buildInterdiff", () => {
	let h: RereviewHistory;
	beforeAll(() => {
		h = createRereviewHistory();
	});
	afterAll(() => h.cleanup());

	const interdiff = async (ps: Endpoints, r: Endpoints) =>
		buildInterdiff(h.path, await detectShape(h.path, ps, r), ps, r);
	const ps = () => ep(h.b0, h.p2);
	/** `files` of an available interdiff, as `[path, status, conflict, clusters]`. */
	const summary = (d: Interdiff) => {
		if (d.status !== "available") throw new Error(`interdiff ${d.status}`);
		return d.files.map((f) => [
			f.oldPath ? `${f.oldPath} -> ${f.path}` : f.path,
			f.status,
			f.conflict,
			f.clusters.map((c) => [
				c.kind,
				c.oldStart,
				c.oldCount,
				c.newStart,
				c.newCount,
				c.removed,
				c.added,
			]),
		]);
	};

	it("I1: commits appended: exactly the new commits' hunks, with both sides' lines", async () => {
		const d = await interdiff(ps(), ep(h.b0, h.h3));
		expect(summary(d)).toEqual([
			[
				"a.txt",
				"modified",
				false,
				[["lines", 35, 1, 35, 1, ["line 35"], ["thirty-five"]]],
			],
		]);
		if (d.status !== "available") throw new Error("unavailable");
		expect(d.files[0]?.oldLines).toEqual(lines({ 2: "two", 30: "thirty" }));
		expect(d.files[0]?.newLines).toEqual(
			lines({ 2: "two", 30: "thirty", 35: "thirty-five" }),
		);
		expect(d.virtualHead).toMatch(/^[0-9a-f]{40}$/);
	});

	it("I2: the base merged in, nothing else: empty", async () => {
		expect(summary(await interdiff(ps(), ep(h.b1, h.merged)))).toEqual([]);
	});

	it("I3: a trivial rebase: empty", async () => {
		expect(summary(await interdiff(ps(), ep(h.b1, h.rebased)))).toEqual([]);
	});

	it("I4: a rebase or a merge plus the author's own edit: only the edit", async () => {
		expect(summary(await interdiff(ps(), ep(h.b1, h.amended)))).toEqual([
			[
				"a.txt",
				"modified",
				false,
				[["lines", 30, 1, 30, 1, ["thirty"], ["thirty!"]]],
			],
		]);
		expect(summary(await interdiff(ps(), ep(h.b1, h.mergedPlus)))).toEqual([
			[
				"a.txt",
				"modified",
				false,
				[["lines", 35, 1, 35, 1, ["line 35"], ["thirty-five"]]],
			],
		]);
	});

	it("I5: a conflict: the conflicted file's full diff from B2, flagged; the clean file as I4", async () => {
		const d = await interdiff(ps(), ep(h.b1c, h.resolvedPlus));
		expect(summary(d)).toEqual([
			["new.txt", "modified", false, [["lines", 1, 0, 2, 1, [], ["more"]]]],
			[
				"a.txt",
				"modified",
				true,
				[
					["lines", 2, 1, 2, 1, ["line 2"], ["two"]],
					["lines", 30, 1, 30, 1, ["thirty-base"], ["thirty resolved"]],
				],
			],
		]);
		if (d.status !== "available") throw new Error("unavailable");
		// The conflicted file's old side is B2's, not the virtual rebase's.
		expect(d.files[1]?.oldLines).toEqual(lines({ 30: "thirty-base" }));
		expect(d.files[1]?.newLines).toEqual(
			lines({ 2: "two", 30: "thirty resolved" }),
		);
	});

	it("I6: a squash with an amend: content only", async () => {
		expect(summary(await interdiff(ps(), ep(h.b0, h.squashAmended)))).toEqual([
			[
				"a.txt",
				"modified",
				false,
				[["lines", 30, 1, 30, 1, ["thirty"], ["thirty!"]]],
			],
		]);
	});

	it("I7: a reverted commit: a deletion", async () => {
		expect(
			summary(await interdiff(ep(h.b0, h.p3), ep(h.b0, h.reverted))),
		).toEqual([
			["extra.txt", "deleted", false, [["lines", 1, 1, 0, 0, ["extra"], []]]],
		]);
	});

	it("I8: a stacked parent squashed into the base, the child rebased: empty", async () => {
		expect(
			summary(
				await interdiff(ep(h.b0, h.child), ep(h.parentLanded, h.childRebased)),
			),
		).toEqual([]);
	});

	it("I10: unrelated histories: unavailable", async () => {
		expect(await interdiff(ps(), ep(h.orphan, h.orphanHead))).toEqual({
			status: "unavailable",
			reason: "unrelated",
		});
	});

	it("Review focus 5: the conflicted file is one the PR deletes: listed deleted, flagged", async () => {
		const d = await interdiff(
			ep(h.withB, h.prDeletesB),
			ep(h.baseEditsB, h.prDeletesBRebased),
		);
		expect(summary(d)).toEqual([
			[
				"b.txt",
				"deleted",
				true,
				[["lines", 1, 2, 0, 0, ["b1", "b2 edited"], []]],
			],
		]);
	});

	it("refuses anything but object ids before running git", async () => {
		const shape = await detectShape(h.path, ps(), ep(h.b0, h.h3));
		await expect(
			buildInterdiff(h.path, shape, ps(), ep("main", h.h3)),
		).rejects.toThrow(/Not an object id/);
		await expect(
			buildInterdiff(
				h.path,
				{ ...shape, virtualHead: "--output=x" },
				ps(),
				ep(h.b0, h.h3),
			),
		).rejects.toThrow(/Not an object id/);
	});
});
