import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	BUILD,
	formatVersion,
	mismatchMessage,
	sameBuild,
	VERSION_HEADER,
} from "./version";

describe("version", () => {
	it("formats as version and short commit", () => {
		expect(
			formatVersion({
				version: "0.4.0-rc.1",
				commit: "93fe843aa1b2c3d4e5f60718293a4b5c6d7e8f90",
			}),
		).toBe("0.4.0-rc.1 (93fe843)");
		expect(
			formatVersion({
				version: "0.4.0",
				commit: "93fe843aa1b2c3d4e5f60718293a4b5c6d7e8f90-dirty",
			}),
		).toBe("0.4.0 (93fe843-dirty)");
	});

	it("names both sides of a mismatch", () => {
		const server = { version: "0.4.0", commit: `abc1234${"0".repeat(33)}` };
		const client = { version: "0.4.0", commit: `def5678${"0".repeat(33)}` };
		expect(mismatchMessage(server, client)).toBe(
			"server runs 0.4.0 (abc1234), this crb is 0.4.0 (def5678). Restart the server (crb serve) or run the matching crb",
		);
		expect(sameBuild(server, client)).toBe(false);
		expect(sameBuild(server, { ...server })).toBe(true);
		expect(sameBuild(server, { ...server, version: "0.4.1" })).toBe(false);
	});

	it("in a source run, is package.json's version and HEAD", () => {
		const pkg = JSON.parse(
			readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
		);
		const head = execFileSync("git", ["rev-parse", "HEAD"], {
			encoding: "utf8",
		}).trim();
		expect(BUILD).toEqual({ version: pkg.version, commit: head });
		expect(VERSION_HEADER).toBe("x-crb-version");
	});
});
