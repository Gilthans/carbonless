import { execFileSync } from "node:child_process";
import { ulid } from "ulid";
import { newEvent, serializeCommitMessage } from "../src/server/review/events";
import { testGitEnv } from "./git-fixture";

/*
 * Started reviews written straight into a clone with `git fast-import`
 * (CAR-324): many at once, without a server, a fake gh or ReviewService,
 * for the scaling guards that need N and 4N of them. Each is a review of
 * its own PR: a head changing 3 files from `base`, a meta ref, a progress
 * ref with a patch set and `marks` cluster-state commits (synthetic cluster
 * keys, so they cover nothing: coverage reads 0 of the snapshot's lines).
 */

function git(cwd: string, args: string[], input?: string): string {
	return execFileSync("git", args, {
		cwd,
		input,
		encoding: "utf8",
		env: testGitEnv(),
		maxBuffer: 1 << 28,
	}).trim();
}

const data = (s: string) => `data ${Buffer.byteLength(s)}\n${s}\n`;

export interface SeededReview {
	id: string;
	number: number;
}

/** `k` started reviews of `owner/repo` PRs `from`.. in the bare clone `clone`, by `slug`. */
export function seedStartedReviews(
	clone: string,
	options: {
		owner: string;
		repo: string;
		slug: string;
		k: number;
		from: number;
		marks?: number;
		/** The commit the heads branch from (default: HEAD). */
		base?: string;
	},
): SeededReview[] {
	const { owner, repo, slug, k, from, marks = 2 } = options;
	if (k === 0) return [];
	const base = options.base ?? git(clone, ["rev-parse", "HEAD"]);
	const tag = `seed-${from}`;
	let s = "";
	for (let i = 0; i < k; i++) {
		s += `commit refs/heads/${tag}/${i}\ncommitter b <b@b> 1700000100 +0000\n${data(`head ${i}`)}from ${base}\n`;
		for (let f = 0; f < 3; f++) {
			const text = Array.from(
				{ length: 20 },
				(_, j) => `seed ${f} line ${j}${j === i % 20 ? ` changed ${i}` : ""}`,
			).join("\n");
			s += `M 100644 inline seed/f${f}.txt\n${data(text)}`;
		}
	}
	git(clone, ["fast-import", "--quiet"], s);
	const heads = new Map(
		git(clone, [
			"for-each-ref",
			"--format=%(refname) %(objectname)",
			`refs/heads/${tag}/`,
		])
			.split("\n")
			.map((l) => l.split(" ") as [string, string]),
	);
	const out: SeededReview[] = [];
	const ts0 = 1_700_000_000_000;
	s = "";
	for (let i = 0; i < k; i++) {
		const id = ulid().toLowerCase();
		const number = from + i;
		out.push({ id, number });
		const head = heads.get(`refs/heads/${tag}/${i}`) as string;
		const created = newEvent(
			"review-created",
			slug,
			{
				source: "github-pr",
				key: `${owner}/${repo}#${number}`,
				pr: {
					owner,
					repo,
					number,
					url: `https://github.com/${owner}/${repo}/pull/${number}`,
					baseBranch: "main",
					headBranch: `b${number}`,
					headRepo: `${owner}/${repo}`,
				},
			} as never,
			"human",
			ts0 + i,
		);
		s += `commit refs/crb/reviews/${id}/meta\ncommitter crb <crb@crb> 1700000200 +0000\n${data(serializeCommitMessage("crb: created", [created]))}`;
		const revision = `${base.slice(0, 20)}${head.slice(0, 20)}`;
		const started = newEvent(
			"patchset-started",
			slug,
			{ patchset: 1, revision, mergeBase: base, head } as never,
			"human",
			ts0 + i,
		);
		const progress = `refs/crb/reviews/${id}/reviewers/${slug}/progress`;
		s += `commit ${progress}\ncommitter crb <crb@crb> 1700000200 +0000\n${data(serializeCommitMessage("crb: started PS1", [started]))}`;
		for (let m = 0; m < marks; m++) {
			const e = newEvent(
				"cluster-state",
				slug,
				{
					patchset: revision,
					cluster: `${"c".repeat(48)}${String(m).padStart(16, "0")}`,
					path: `seed/f${m % 3}.txt`,
					state: "reviewed",
				} as never,
				"human",
				ts0 + i + m + 1,
			);
			s += `commit ${progress}\ncommitter crb <crb@crb> 1700000300 +0000\n${data(serializeCommitMessage("crb: reviewed", [e]))}`;
		}
	}
	git(clone, ["fast-import", "--quiet", "--force"], s);
	return out;
}
