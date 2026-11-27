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

/** While `held`, every atomic write waits for it (a busy file on Windows). */
const gate = vi.hoisted(() => ({ held: null as Promise<void> | null }));
vi.mock("./atomicFile", async (original) => {
	const real = await original<typeof import("./atomicFile")>();
	return {
		...real,
		writeFileAtomic: async (
			...args: Parameters<typeof real.writeFileAtomic>
		) => {
			await gate.held;
			return real.writeFileAtomic(...args);
		},
	};
});

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
		gate.held = null;
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
		it("answers the newest note at once while the write is held, and writes one review's notes in order", async () => {
			let release = () => {};
			gate.held = new Promise((r) => {
				release = r;
			});
			recordSeen(ID, HEAD, 1);
			recordSeen(ID, "b".repeat(40), 2);
			expect(await readSeen(ID)).toEqual({ head: "b".repeat(40), at: 2 });
			expect(existsSync(file())).toBe(false);
			release();
			await seenSettled();
			expect(JSON.parse(readFileSync(file(), "utf8"))).toEqual({
				head: "b".repeat(40),
				at: 2,
			});
			expect(await readSeen(ID)).toEqual({ head: "b".repeat(40), at: 2 });
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
