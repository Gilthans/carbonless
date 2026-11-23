import { afterEach, describe, expect, it, vi } from "vitest";
import type { Cluster, DiffLine } from "../../shared/types.js";
import { SPLIT_CELLS } from "../../shared/whitespace.js";
import { hunkView } from "../../web/files/whitespace.js";
import { buildDisplayHunks } from "./hunks.js";
import { clusterKeys } from "./identity.js";
import { cutClusters } from "./snapshot.js";

// The matching behind the cut, made to throw on demand.
const broken = vi.hoisted(() => ({ on: false }));
vi.mock("../../shared/whitespace.js", async (importOriginal) => {
	const real =
		await importOriginal<typeof import("../../shared/whitespace.js")>();
	return {
		...real,
		hunkCuts: (lines: readonly DiffLine[]) => {
			if (broken.on) throw new TypeError("matching bug");
			return real.hunkCuts(lines);
		},
	};
});

afterEach(() => {
	broken.on = false;
});

/**
 * `git diff -U0`-shaped hunks between two texts, by an exact longest common
 * subsequence (as git keeps byte-equal lines unchanged, accidental ones
 * included): each run of lines off it one hunk, numbered as git numbers
 * them (a side with no lines starts at the line it follows).
 */
function u0Hunks(old: string[], young: string[]): Omit<Cluster, "key">[] {
	const n = old.length;
	const m = young.length;
	const w = m + 1;
	const best = new Uint32Array((n + 1) * w);
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			best[i * w + j] =
				old[i] === young[j]
					? (best[(i + 1) * w + j + 1] as number) + 1
					: Math.max(
							best[(i + 1) * w + j] as number,
							best[i * w + j + 1] as number,
						);
		}
	}
	const hunks: Omit<Cluster, "key">[] = [];
	let i = 0;
	let j = 0;
	let open: { i: number; j: number } | null = null;
	const close = () => {
		if (!open) return;
		const removed = old.slice(open.i, i);
		const added = young.slice(open.j, j);
		hunks.push({
			kind: "lines",
			oldStart: removed.length > 0 ? open.i + 1 : open.i,
			oldCount: removed.length,
			newStart: added.length > 0 ? open.j + 1 : open.j,
			newCount: added.length,
			removed,
			added,
			lines: removed.length + added.length,
		});
		open = null;
	};
	while (i < n || j < m) {
		if (i < n && j < m && old[i] === young[j]) {
			close();
			i++;
			j++;
			continue;
		}
		open ??= { i, j };
		if (
			j >= m ||
			(i < n &&
				(best[(i + 1) * w + j] as number) >= (best[i * w + j + 1] as number))
		)
			i++;
		else j++;
	}
	close();
	return hunks;
}

const cut = (old: string[], young: string[]) => {
	const hunks = u0Hunks(old, young);
	return cutClusters(hunks, (cs) => clusterKeys("cut.ts", cs, young), {
		oldLines: old,
		newLines: young,
		noNewlineAtEnd: false,
	});
};

describe("the snapshot's cut (CAR-218)", () => {
	it("doesn't fall back to the per-hunk cut when the matching throws", () => {
		const old = ["a", "  b", "c"];
		const young = ["a", "b", "c"];
		expect(cut(old, young).map((c) => c.whitespaceOnly)).toEqual([true]);
		broken.on = true;
		expect(() => cut(old, young)).toThrow("matching bug");
	});

	it("agrees with the view's `~` rows line for line, for any texts, over the cap too", () => {
		let seed = 2218;
		const rand = (k: number) => {
			seed = (seed * 1103515245 + 12345) & 0x7fffffff;
			// The high bits: an LCG's low bits cycle with a short period.
			return (seed >>> 16) % k;
		};
		// A small vocabulary, so lines byte-match others by accident.
		const words = ["<div>", "</div>", "}", "a();", "if (x) {", "", "b"];
		const pad = ["", "  ", "    ", "\t"];
		const line = () => `${pad[rand(pad.length)]}${words[rand(words.length)]}`;
		const indent = (l: string) => (l === "" ? l : `  ${l}`);
		/** The old text edited: blocks re-indented (wrapped), lines changed, dropped, added, moved. */
		const edit = (old: string[], rate: number) => {
			const young: string[] = [];
			let deeper = 0;
			const moved: string[] = [];
			for (const l of old) {
				if (deeper === 0 && rand(rate) === 0) {
					deeper = 2 + rand(8);
					young.push("<Provider>");
				}
				const r = rand(rate * 2);
				if (r === 0) continue;
				if (r === 1) young.push(line());
				else if (r === 2) moved.push(l);
				else young.push(deeper > 0 ? indent(l) : l);
				if (r === 3) young.push(line());
				if (deeper > 0 && --deeper === 0) young.push("</Provider>");
				if (moved.length > 0 && rand(4) === 0)
					young.push(indent(moved.shift() as string));
			}
			if (deeper > 0) young.push("</Provider>");
			young.push(...moved.map(indent));
			return young;
		};
		let checked = 0;
		let overCap = 0;
		const check = (old: string[], young: string[]) => {
			const clusters = cut(old, young);
			const byKey = new Map(clusters.map((c) => [c.key, c]));
			for (const display of buildDisplayHunks(old, young, clusters, 3)) {
				const sides =
					display.lines.filter((l) => l.kind !== "add").length *
					display.lines.filter((l) => l.kind !== "del").length;
				if (sides > SPLIT_CELLS) overCap++;
				const ws = new Set<DiffLine>();
				for (const run of hunkView(display.lines, true).runs) {
					for (const row of run.rows) {
						if (row.kind !== "ws") continue;
						if (row.del) ws.add(row.del);
						if (row.add) ws.add(row.add);
					}
				}
				for (const l of display.lines) {
					if (l.kind === "context") continue;
					const cluster = byKey.get(l.clusterKey as string);
					expect(cluster).toBeDefined();
					// A `~` row exactly where the cluster is whitespace-only.
					expect(
						{ line: l.text, ws: ws.has(l) },
						`${l.kind} ${l.oldNo ?? l.newNo}`,
					).toEqual({ line: l.text, ws: cluster?.whitespaceOnly === true });
					checked++;
				}
			}
		};
		for (let k = 0; k < 400; k++) {
			const old = Array.from({ length: 4 + rand(40) }, line);
			check(old, edit(old, 3 + rand(6)));
		}
		// Display hunks over the cap: changes close enough together that
		// git's hunks share one display hunk of more than SPLIT_CELLS cells.
		for (let k = 0; k < 3; k++) {
			const old = Array.from({ length: 560 }, line);
			check(old, edit(old, 2));
		}
		expect(checked).toBeGreaterThan(5000);
		expect(overCap).toBeGreaterThan(0);
	});
});
