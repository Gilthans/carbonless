import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createGitFixture, testGitEnv } from "./git-fixture";

/**
 * One PR history with every shape the re-review engine tells apart
 * (Linear CAR-5, document "Re-review after new pushes: scenarios and prior art",
 * S1–S9 and I1–I10): the PR (two commits on `b0`: a.txt lines 2 and 30,
 * plus new.txt), the base moving on (`b1`: line 15), with and without
 * touching a line the PR changed (`b1c`: line 30), and each way the author
 * may have updated: appended, merged the base in, rebased (trivially, with
 * a conflict, with an amend), squashed, reverted, moved back, a stacked
 * parent landed by squash.
 */
export const LINES = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`);
/** a.txt with these 1-based lines replaced. */
export const aTxt = (changes: Record<number, string>) =>
	`${LINES.map((l, i) => changes[i + 1] ?? l).join("\n")}\n`;

export function createRereviewHistory() {
	const fx = createGitFixture([
		{ message: "base", files: { "a.txt": aTxt({}) } },
	]);
	const git = (...args: string[]) =>
		execFileSync("git", args, {
			cwd: fx.path,
			encoding: "utf8",
			stdio: "pipe",
			env: testGitEnv(),
		}).trim();
	const commit = (message: string, files: Record<string, string>) => {
		for (const [name, content] of Object.entries(files)) {
			writeFileSync(join(fx.path, name), content);
		}
		git("add", "--all");
		git("commit", "--quiet", "-m", message);
		return git("rev-parse", "HEAD");
	};
	const checkout = (sha: string) => git("checkout", "--quiet", "--detach", sha);
	const head = () => git("rev-parse", "HEAD");

	const b0 = fx.shas[0] as string;
	const p1 = commit("PR: line 2 and new.txt", {
		"a.txt": aTxt({ 2: "two" }),
		"new.txt": "new\n",
	});
	const p2 = commit("PR: line 30", {
		"a.txt": aTxt({ 2: "two", 30: "thirty" }),
	});
	// S1: a commit appended.
	const h3 = commit("PR: line 35", {
		"a.txt": aTxt({ 2: "two", 30: "thirty", 35: "thirty-five" }),
	});
	// S1 with a reviewed change reworked: line 30 edited again.
	checkout(p2);
	const reworked = commit("PR: line 30 again", {
		"a.txt": aTxt({ 2: "two", 30: "thirty-two" }),
	});
	// ... and back to what PS1 had (P8: carried from the earlier patch set).
	const reworkedBack = commit("PR: line 30 back", {
		"a.txt": aTxt({ 2: "two", 30: "thirty" }),
	});
	// S9: a PR commit reverted (extra.txt added, then removed).
	checkout(p2);
	const p3 = commit("PR: extra.txt", { "extra.txt": "extra\n" });
	git("revert", "--no-edit", p3);
	const reverted = head();
	// A deletion the PR made (line 20), then restored by the author.
	checkout(p2);
	const deletesLine = commit("PR: drop line 20", {
		"a.txt": aTxt({ 2: "two", 30: "thirty" }).replace("line 20\n", ""),
	});
	const restoresLine = commit("PR: line 20 back", {
		"a.txt": aTxt({ 2: "two", 30: "thirty" }),
	});
	// A path that looks like a glob, changed by the PR, then more appended.
	checkout(b0);
	const g0 = commit("base: we[i]rd.txt", { "we[i]rd.txt": "w1\nw2\nw3\n" });
	const g1 = commit("PR: we[i]rd.txt", { "we[i]rd.txt": "w1\nW2\nw3\n" });
	const g2 = commit("PR: a.txt too", { "a.txt": aTxt({ 2: "two" }) });
	// A conflict on the glob-looking path while its look-alike neighbour
	// rebases cleanly: the PR changes both, the base changes only we[i]rd.txt.
	checkout(b0);
	const gw0 = commit("base: we[i]rd.txt and weird.txt", {
		"we[i]rd.txt": "w1\nw2\nw3\n",
		"weird.txt": "x1\nx2\nx3\n",
	});
	const gw1 = commit("PR: both", {
		"we[i]rd.txt": "w1\nW2\nw3\n",
		"weird.txt": "x1\nX2\nx3\n",
	});
	checkout(gw0);
	const gwBase = commit("base: we[i]rd.txt line 2", {
		"we[i]rd.txt": "w1\nw2 base\nw3\n",
	});
	const gwResolved = commit("PR: both (rebased, resolved)", {
		"we[i]rd.txt": "w1\nW2 resolved\nw3\n",
		"weird.txt": "x1\nX2\nx3\n",
	});

	checkout(b0);
	const b1 = commit("base: line 15", { "a.txt": aTxt({ 15: "fifteen" }) });
	checkout(b0);
	const b1c = commit("base: line 30", { "a.txt": aTxt({ 30: "thirty-base" }) });
	// S3: the base merged into the PR.
	checkout(p2);
	git("merge", "--quiet", "--no-ff", "-m", "Merge base", b1);
	const merged = head();
	// S3 with the author's own change on top of the merge.
	const mergedPlus = commit("PR: line 35 after merge", {
		"a.txt": aTxt({ 2: "two", 15: "fifteen", 30: "thirty", 35: "thirty-five" }),
	});
	// S4a: a trivial rebase onto b1.
	checkout(b1);
	git("cherry-pick", "--quiet", p1, p2);
	const rebased = head();
	// S4c: a rebase plus an amend of line 30.
	const amended = commit("PR: line 30, amended", {
		"a.txt": aTxt({ 2: "two", 15: "fifteen", 30: "thirty!" }),
	});
	// S4b: a rebase onto a base that changed line 30 too, resolved by hand;
	// new.txt and line 2 rebase cleanly.
	checkout(b1c);
	git("cherry-pick", "--quiet", p1);
	const resolved = commit("PR: line 30 (resolved)", {
		"a.txt": aTxt({ 2: "two", 30: "thirty resolved" }),
	});
	// ... and the author's own edit of a file that rebased cleanly.
	const resolvedPlus = commit("PR: more in new.txt", {
		"new.txt": "new\nmore\n",
	});
	// S4b where the conflicted file is one the PR deletes: the PR removes
	// b.txt, the base edits it.
	checkout(b0);
	const withB = commit("base: b.txt", { "b.txt": "b1\nb2\n" });
	const prDeletesB = (() => {
		git("rm", "-q", "b.txt");
		git("commit", "--quiet", "-m", "PR: delete b.txt");
		return head();
	})();
	checkout(withB);
	const baseEditsB = commit("base: edit b.txt", { "b.txt": "b1\nb2 edited\n" });
	checkout(baseEditsB);
	git("rm", "-q", "b.txt");
	git("commit", "--quiet", "-m", "PR: delete b.txt (rebased)");
	const prDeletesBRebased = head();
	// S5: the two PR commits squashed into one, same content.
	checkout(b0);
	git("merge", "--quiet", "--squash", p2);
	git("commit", "--quiet", "-m", "PR (squashed)");
	const squashed = head();
	// S4c on the same base: squashed with line 30 amended.
	checkout(b0);
	const squashAmended = commit("PR (squashed, amended)", {
		"a.txt": aTxt({ 2: "two", 30: "thirty!" }),
		"new.txt": "new\n",
	});
	// S8: a stacked parent (line 10, parent.txt) under the PR, landed by
	// squash into the base, the PR rebased onto that.
	checkout(b0);
	const parent = commit("parent: line 10 and parent.txt", {
		"a.txt": aTxt({ 10: "ten-parent" }),
		"parent.txt": "parent\n",
	});
	git("cherry-pick", "--quiet", p1, p2);
	const child = head();
	checkout(b1);
	git("merge", "--quiet", "--squash", parent);
	git("commit", "--quiet", "-m", "parent (squashed)");
	const parentLanded = head();
	git("cherry-pick", "--quiet", p1, p2);
	const childRebased = head();
	// Unrelated: another root.
	git("checkout", "--quiet", "--orphan", "other");
	git("rm", "-rfq", ".");
	const orphan = commit("orphan", { "z.txt": "z\n" });
	const orphanHead = commit("orphan: more", { "z.txt": "zz\n" });
	git("checkout", "--quiet", "main");
	// Branches for a shallow clone to fetch.
	git("branch", "-f", "pr", p2);
	git("branch", "-f", "rebased", rebased);
	git("branch", "-f", "moved", b1);
	return {
		path: fx.path,
		cleanup: fx.cleanup,
		git,
		b0,
		p1,
		p2,
		p3,
		h3,
		reworked,
		reworkedBack,
		reverted,
		deletesLine,
		restoresLine,
		g0,
		g1,
		g2,
		gw0,
		gw1,
		gwBase,
		gwResolved,
		b1,
		b1c,
		merged,
		mergedPlus,
		rebased,
		amended,
		resolved,
		resolvedPlus,
		withB,
		prDeletesB,
		baseEditsB,
		prDeletesBRebased,
		squashed,
		squashAmended,
		parent,
		child,
		parentLanded,
		childRebased,
		orphan,
		orphanHead,
	};
}

export type RereviewHistory = ReturnType<typeof createRereviewHistory>;
