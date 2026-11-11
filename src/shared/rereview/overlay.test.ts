import { describe, expect, it } from "vitest";
import type { FileView, RereviewAnswer, ReviewView } from "../types.js";
import { overlayCarries } from "./overlay.js";

const cluster = (key: string): FileView["clusters"][number] => ({
	key,
	kind: "lines",
	oldStart: 1,
	oldCount: 1,
	newStart: 1,
	newCount: 1,
	removed: ["a"],
	added: ["b"],
	lines: 2,
	state: "unreviewed",
});

const view = (): ReviewView => {
	const files: FileView[] = [
		{
			index: 0,
			path: "a.txt",
			status: "modified",
			binary: false,
			submodule: false,
			additions: 1,
			deletions: 1,
			clusters: [cluster("k1"), cluster("k2")],
			done: false,
			reviewed: false,
			crossedOff: false,
		},
	];
	const counts = { total: 2, reviewed: 0, crossedOff: 0 };
	return {
		revision: "r2",
		patchset: null,
		files,
		progress: {
			clusters: counts,
			lines: { total: 4, reviewed: 0, crossedOff: 0 },
			files: { total: 1, reviewed: 0, crossedOff: 0, done: 0 },
		},
	};
};

const answer = (
	clusters: RereviewAnswer["files"][number]["clusters"],
): RereviewAnswer => ({
	from: 1,
	toHead: "h",
	toRevision: "r2",
	shape: {
		code: "S1",
		commits: 1,
		identical: false,
		conflicts: [],
		virtualRebase: "ok",
		virtualHead: null,
	},
	interdiff: "available",
	files: [{ index: 0, path: "a.txt", conflict: false, clusters }],
	toRead: { files: 1, clusters: 1 },
	threads: [],
});

describe("overlayCarries", () => {
	it("marks carried clusters with their source and rule, and recounts", () => {
		const out = overlayCarries(
			view(),
			answer([
				{
					key: "k1",
					kind: "carried",
					from: 1,
					state: "reviewed",
					rule: "exact",
				},
				{ key: "k2", kind: "new" },
			]),
		);
		expect(out.files[0]?.clusters[0]).toMatchObject({
			state: "reviewed",
			carried: { from: 1, rule: "exact" },
		});
		expect(out.files[0]?.clusters[1]?.state).toBe("unreviewed");
		expect(out.progress.clusters).toEqual({
			total: 2,
			reviewed: 1,
			crossedOff: 0,
		});
		expect(out.files[0]?.done).toBe(false);
	});
	it("a crossed-off carry carries as crossed off", () => {
		const out = overlayCarries(
			view(),
			answer([
				{
					key: "k1",
					kind: "carried",
					from: 1,
					state: "crossed-off",
					rule: "rename",
				},
			]),
		);
		expect(out.files[0]?.clusters[0]).toMatchObject({
			state: "crossed-off",
			carried: { from: 1, rule: "rename" },
		});
	});
	it("an entry missing its source, state or rule marks nothing (fail closed)", () => {
		const v = view();
		for (const entry of [
			{
				key: "k1",
				kind: "carried" as const,
				state: "reviewed" as const,
				rule: "exact" as const,
			},
			{ key: "k1", kind: "carried" as const, from: 1, rule: "exact" as const },
			{
				key: "k1",
				kind: "carried" as const,
				from: 1,
				state: "reviewed" as const,
			},
			{
				key: "k9",
				kind: "carried" as const,
				from: 1,
				state: "reviewed" as const,
				rule: "exact" as const,
			},
		]) {
			const out = overlayCarries(v, answer([entry]));
			expect(out.files[0]?.clusters[0]?.state).toBe("unreviewed");
			expect(out.progress.clusters.reviewed).toBe(0);
		}
	});
	it("returns the view itself when nothing carries", () => {
		const v = view();
		expect(overlayCarries(v, answer([{ key: "k1", kind: "new" }]))).toBe(v);
	});
});
