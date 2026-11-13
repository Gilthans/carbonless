import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ReviewClaim, takeClaim } from "./claim.js";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "crb-claim-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A pid no process has: one that just exited. */
const deadPid = () => spawnSync(process.execPath, ["-e", ""]).pid as number;
const file = () => join(dir, "claim.json");

describe("takeClaim", () => {
	it("is taken, with pid and port in claim.json", async () => {
		const claim = await takeClaim(dir, { pid: process.pid, port: 4800 });
		expect(claim.ok).toBe(true);
		expect(JSON.parse(readFileSync(file(), "utf8"))).toMatchObject({
			pid: process.pid,
			port: 4800,
		});
	});

	it("a second take by another port fails with the holder", async () => {
		await takeClaim(dir, { pid: process.pid, port: 4800 });
		expect(await takeClaim(dir, { pid: process.pid, port: 4801 })).toEqual({
			ok: false,
			holder: { pid: process.pid, port: 4800 },
		});
	});

	it("a dead pid's claim is replaced", async () => {
		writeFileSync(file(), JSON.stringify({ pid: deadPid(), port: 4800 }));
		const claim = await takeClaim(dir, { pid: process.pid, port: 4801 });
		expect(claim.ok).toBe(true);
		expect(JSON.parse(readFileSync(file(), "utf8")).port).toBe(4801);
	});

	it("racing takers on a dead claim: exactly one wins, and the file names it", async () => {
		const dead = deadPid();
		for (let round = 0; round < 20; round++) {
			writeFileSync(file(), JSON.stringify({ pid: dead, port: 4799 }));
			const takes = await Promise.all(
				Array.from({ length: 8 }, (_, i) =>
					takeClaim(dir, { pid: process.pid, port: 4800 + i }),
				),
			);
			const won = takes.flatMap((t, i) => (t.ok ? [4800 + i] : []));
			expect(won, `round ${round}`).toHaveLength(1);
			expect(JSON.parse(readFileSync(file(), "utf8")).port).toBe(won[0]);
			rmSync(file());
		}
	});

	it("a claim that isn't JSON is replaced", async () => {
		writeFileSync(file(), "{half");
		expect((await takeClaim(dir, { pid: process.pid, port: 4801 })).ok).toBe(
			true,
		);
	});

	it("release unlinks", async () => {
		const claim = await takeClaim(dir, { pid: process.pid, port: 4800 });
		if (!claim.ok) throw new Error("not taken");
		await claim.release();
		expect(existsSync(file())).toBe(false);
	});

	it("release after someone else took it leaves theirs", async () => {
		const claim = await takeClaim(dir, { pid: process.pid, port: 4800 });
		if (!claim.ok) throw new Error("not taken");
		rmSync(file());
		const theirs = await takeClaim(dir, { pid: process.pid, port: 4801 });
		expect(theirs.ok).toBe(true);
		await claim.release();
		expect(JSON.parse(readFileSync(file(), "utf8")).port).toBe(4801);
	});
});

describe("ReviewClaim", () => {
	const self = () => ({ pid: process.pid, port: 4800 });

	it("a hold while a drop is still releasing waits for it and is ok (not its own claim as another's)", async () => {
		const claim = new ReviewClaim(dir, self);
		expect((await claim.hold("join")).ok).toBe(true);
		const dropping = claim.drop("join");
		const again = await claim.hold("acp");
		await dropping;
		expect(again.ok).toBe(true);
		expect(claim.held()).toBe(true);
		expect(existsSync(file())).toBe(true);
	});

	it("shared by two users: released only when both drop", async () => {
		const claim = new ReviewClaim(dir, self);
		await claim.hold("join");
		await claim.hold("acp");
		await claim.drop("join");
		expect(existsSync(file())).toBe(true);
		await claim.drop("acp");
		expect(existsSync(file())).toBe(false);
		expect(claim.held()).toBe(false);
	});
});
