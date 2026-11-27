import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readSeen, recordSeen, seenSettled, writeSeen } from "./seen";

/**
 * The next atomic writes, in turn, each wait for one hold (a busy file on
 * Windows); `started` lists the data of every write that began.
 */
const gate = vi.hoisted(() => ({
	holds: [] as Promise<void>[],
	started: [] as string[],
}));
vi.mock("./atomicFile", async (original) => {
	const real = await original<typeof import("./atomicFile")>();
	return {
		...real,
		writeFileAtomic: async (
			...args: Parameters<typeof real.writeFileAtomic>
		) => {
			gate.started.push(args[1]);
			await gate.holds.shift();
			return real.writeFileAtomic(...args);
		},
	};
});

/** Holds the next write that starts; the result lets it go. */
const holdNextWrite = (): (() => void) => {
	let release = () => {};
	gate.holds.push(
		new Promise((r) => {
			release = r;
		}),
	);
	return release;
};

const ID = "01jb0000000000000000000000";
const HEAD = "a".repeat(40);

describe("last-seen head", () => {
	let dir: string;
	let saved: string | undefined;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "crb-seen-"));
		saved = process.env.XDG_STATE_HOME;
		process.env.XDG_STATE_HOME = dir;
	});
	afterEach(async () => {
		gate.holds = [];
		gate.started = [];
		await seenSettled();
		if (saved === undefined) delete process.env.XDG_STATE_HOME;
		else process.env.XDG_STATE_HOME = saved;
		rmSync(dir, { recursive: true, force: true });
	});

	const file = () => join(dir, "carbonless", "seen", `${ID}.json`);

	it("is null before anything was written", async () => {
		expect(await readSeen(ID)).toBeNull();
	});

	it("round-trips the head and the time, under the state dir", async () => {
		await writeSeen(ID, HEAD, 1234);
		expect(await readSeen(ID)).toEqual({ head: HEAD, at: 1234 });
		expect(JSON.parse(readFileSync(file(), "utf8"))).toEqual({
			head: HEAD,
			at: 1234,
		});
		// A later write replaces it; the time defaults to now.
		const before = Date.now();
		await writeSeen(ID, "b".repeat(40));
		const seen = await readSeen(ID);
		expect(seen?.head).toBe("b".repeat(40));
		expect(seen?.at).toBeGreaterThanOrEqual(before);
	});

	it("tolerates a corrupt or ill-typed file", async () => {
		mkdirSync(join(dir, "carbonless", "seen"), { recursive: true });
		for (const text of [
			"",
			"{not json",
			"[]",
			"null",
			'{"head":5,"at":1}',
			'{"head":"not an oid","at":1}',
			`{"head":"${HEAD}","at":"1"}`,
			`{"head":"${HEAD}"}`,
		]) {
			writeFileSync(file(), text);
			expect(await readSeen(ID)).toBeNull();
		}
	});

	it("refuses a review id that isn't one, before touching the disk", async () => {
		for (const bad of ["../x", "", "01JB0000000000000000000000", "a/b"]) {
			await expect(readSeen(bad)).rejects.toThrow(/review id/);
			await expect(writeSeen(bad, HEAD)).rejects.toThrow(/review id/);
		}
		await expect(writeSeen(ID, "HEAD")).rejects.toThrow(/object ID/);
	});

	describe("recorded without waiting for the disk (CAR-181)", () => {
		const B = "b".repeat(40);
		const note = (head: string, at: number) =>
			`${JSON.stringify({ head, at })}\n`;
		/** Lets pending promise callbacks and I/O run. */
		const turn = () => new Promise((r) => setImmediate(r));

		it("answers the newest note at once while the write is held", async () => {
			const release = holdNextWrite();
			expect(recordSeen(ID, HEAD, 1)).toBe(true);
			expect(await readSeen(ID)).toEqual({ head: HEAD, at: 1 });
			expect(existsSync(file())).toBe(false);
			release();
			await seenSettled(ID);
			expect(JSON.parse(readFileSync(file(), "utf8"))).toEqual({
				head: HEAD,
				at: 1,
			});
		});

		it("writes one review's notes in order: a newer note waits for the older write", async () => {
			const release = holdNextWrite();
			recordSeen(ID, HEAD, 1);
			recordSeen(ID, B, 2);
			for (let i = 0; i < 5; i++) await turn();
			// The newer note's write hasn't started behind the held one.
			expect(gate.started).toEqual([note(HEAD, 1)]);
			expect(await readSeen(ID)).toEqual({ head: B, at: 2 });
			release();
			await seenSettled(ID);
			expect(gate.started).toEqual([note(HEAD, 1), note(B, 2)]);
			expect(JSON.parse(readFileSync(file(), "utf8"))).toEqual({
				head: B,
				at: 2,
			});
		});

		it("waits only for the review asked about", async () => {
			const OTHER = "01jb0000000000000000000001";
			const release = holdNextWrite();
			recordSeen(OTHER, HEAD, 1);
			recordSeen(ID, B, 2);
			await seenSettled(ID);
			expect(JSON.parse(readFileSync(file(), "utf8"))).toEqual({
				head: B,
				at: 2,
			});
			release();
		});

		it("a review id or head that isn't one is no note, not even while a write is pending", async () => {
			const release = holdNextWrite();
			expect(recordSeen(ID, "not an oid", 1)).toBe(false);
			expect(await readSeen(ID)).toBeNull();
			expect(recordSeen("../x", HEAD, 1)).toBe(false);
			expect(gate.started).toEqual([]);
			release();
		});

		it("a failed write only loses the note", async () => {
			// A file where the state dir should be: the write can't land.
			writeFileSync(join(dir, "carbonless"), "");
			recordSeen(ID, HEAD, 1);
			await seenSettled();
			expect(await readSeen(ID)).toBeNull();
		});
	});
});
