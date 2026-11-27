import fs from "node:fs";
import { readFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GIT_TEST_TIMEOUTS } from "../../test/git-fixture";
import { createPrFixture, type PrFixture } from "../../test/pr-fixture";
import { closeCatFiles } from "./catFile";
import { clonePath } from "./clone";
import { StartedReviews } from "./home/started";
import { cacheDir } from "./paths";
import { RefStore } from "./review/refStore";
import { findReviewById } from "./review/reviews";
import { Session } from "./session";

// Real git and fake-gh processes: see GIT_TEST_TIMEOUTS.
vi.setConfig(GIT_TEST_TIMEOUTS);

/*
 * CAR-326, the owner: "I don't want us reading refs not through git's
 * CLI". Every fs call crb's real flows make (a review's open and mark,
 * Home's scan cold and warm, finding a review by id hinted and by scan,
 * ref tips and events) is recorded, and none may name a path inside a
 * git directory: git's files are read by git processes only. The clone
 * directory itself (crb's existence and identity checks) and its lock
 * beside it (`<clone>.git.lock`) are crb's own.
 */

/** The fs functions that read or look at a path, spied on. */
const SYNC = [
	"readFileSync",
	"openSync",
	"statSync",
	"lstatSync",
	"readdirSync",
	"accessSync",
	"existsSync",
	"realpathSync",
	"opendirSync",
	"readlinkSync",
	"createReadStream",
] as const;
const PROMISES = [
	"readFile",
	"open",
	"stat",
	"lstat",
	"readdir",
	"access",
	"realpath",
	"opendir",
	"readlink",
] as const;

const seen: string[] = [];
const restore: (() => void)[] = [];

const pathOf = (arg: unknown): string | null =>
	typeof arg === "string"
		? arg
		: arg instanceof URL
			? arg.pathname
			: Buffer.isBuffer(arg)
				? arg.toString()
				: null;

function spy(target: Record<string, unknown>, name: string): void {
	const original = target[name];
	if (typeof original !== "function") return;
	target[name] = function (this: unknown, ...args: unknown[]) {
		const path = pathOf(args[0]);
		if (path !== null) seen.push(path);
		return original.apply(this, args);
	};
	restore.push(() => {
		target[name] = original;
	});
}

/** A path inside a git directory (a segment `<x>.git` or `.git`, and more after it). */
function insideGitDir(path: string): boolean {
	const parts = path.split(/[/\\]+/);
	const at = parts.findIndex((p) => p.endsWith(".git"));
	return at >= 0 && at < parts.length - 1 && parts[at + 1] !== "";
}

describe("crb's flows open no file of git's (CAR-326)", () => {
	let pr: PrFixture;
	beforeEach(() => {
		pr = createPrFixture();
	});
	afterEach(async () => {
		for (const r of restore.splice(0)) r();
		syncBuiltinESMExports();
		await closeCatFiles();
		await pr.cleanup();
	});

	const record = () => {
		seen.length = 0;
		const target = fs as unknown as Record<string, unknown>;
		for (const name of SYNC) spy(target, name);
		for (const name of PROMISES) {
			spy(fs.promises as unknown as Record<string, unknown>, name);
		}
		// The ESM named imports (`import { readFile } from "node:fs/promises"`)
		// see the spies too.
		syncBuiltinESMExports();
	};

	it("a review's open and mark, Home's scan, finding it by id, ref reads", async () => {
		record();
		const s = await Session.open(pr.arg, process.cwd());
		const key = s.snapshot().files[0]?.clusters[0]?.key as string;
		await s.setStates(s.snapshot().revision, [{ key, state: "reviewed" }]);
		const id = s.id;
		await s.close();
		const clone = clonePath("acme", "widget");
		const scanner = new StartedReviews();
		const cold = await scanner.list("octo-cat", new Set(["acme/widget"]));
		const warm = await scanner.list("octo-cat", new Set(["acme/widget"]));
		expect(cold.map((r) => r.id)).toEqual([id]);
		expect(warm).toEqual(cold);
		// By scan (no hint), then by the hint the scan left.
		fs.rmSync(`${cacheDir()}${sep}review-clones`, {
			recursive: true,
			force: true,
		});
		expect((await findReviewById(cacheDir(), id))?.repoDir).toBe(clone);
		expect((await findReviewById(cacheDir(), id))?.repoDir).toBe(clone);
		const store = new RefStore(clone);
		const ref = `refs/crb/reviews/${id}/reviewers/octo-cat/progress`;
		expect(await store.tip(ref)).toMatch(/^[0-9a-f]{40}$/);
		expect((await store.readEventsAt(ref)).events.length).toBeGreaterThan(0);

		// The spy sees what crb's modules import by name: the clone itself
		// (its existence and identity), and a read into it would show.
		expect(seen).toContain(clone);
		const before = seen.length;
		await readFile(`${clone}${sep}HEAD`, "utf8");
		expect(seen.slice(before).filter(insideGitDir)).toEqual([
			`${clone}${sep}HEAD`,
		]);
		expect(seen.slice(0, before).filter(insideGitDir)).toEqual([]);
	});
});
