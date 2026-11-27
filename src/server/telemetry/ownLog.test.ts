import {
	closeSync,
	mkdtempSync,
	openSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fdIsFile, startOwnLog } from "./ownLog";

describe("crb serve's own log", () => {
	let dir: string;
	let file: string;
	const say = (line: string) => process.stderr.write(line);
	const read = (path = file) => {
		try {
			return readFileSync(path, "utf8");
		} catch {
			return "";
		}
	};

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "crb-own-log-"));
		file = join(dir, "serve-own.log");
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("keeps what crb serve writes to stderr while the mailbox is on, rolling past its limit", () => {
		let on = false;
		const stop = startOwnLog({
			enabled: () => on,
			file,
			limit: 40,
			stderrIsServeLog: false,
		});
		try {
			say("crb: before the mailbox\n");
			on = true;
			say("crb: line one, 20b\n");
			say("crb: line two, 20b\n");
			say("crb: line three\n");
			on = false;
			say("crb: after\n");
		} finally {
			stop();
		}
		say("crb: unwrapped\n");
		expect(read(`${file}.1`)).toBe("crb: line one, 20b\ncrb: line two, 20b\n");
		expect(read()).toBe("crb: line three\n");
	});

	it("isn't kept when stderr already is serve.log: those lines are there once", () => {
		const stop = startOwnLog({
			enabled: () => true,
			file,
			stderrIsServeLog: true,
		});
		say("crb: into serve.log only\n");
		stop();
		expect(read()).toBe("");
	});

	it("tells whether a file descriptor is a given file", () => {
		const a = join(dir, "a.log");
		const b = join(dir, "b.log");
		writeFileSync(a, "");
		writeFileSync(b, "");
		const fd = openSync(a, "a");
		try {
			expect(fdIsFile(fd, a)).toBe(true);
			expect(fdIsFile(fd, b)).toBe(false);
			expect(fdIsFile(fd, join(dir, "missing.log"))).toBe(false);
		} finally {
			closeSync(fd);
		}
	});
});
