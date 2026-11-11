import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readSeen, writeSeen } from "./seen";

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
	afterEach(() => {
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
});
