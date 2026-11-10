import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseSessionToken, sessionToken, watchCommand } from "./watch";

const ID = "01k9e6m2q8x4v7c3n5b0h1j2t6";
const SECRET = "A".repeat(20) + "b_-".repeat(7) + "z".repeat(2);
const TOKEN = sessionToken(ID, SECRET);
const ORIGIN = "http://100.64.1.2:4747";

describe("the watch command", () => {
	let bin: string;
	beforeEach(() => {
		// A curl that prints its arguments, one per line, and exits with $CURL_EXIT.
		bin = mkdtempSync(join(tmpdir(), "crb-watch-"));
		writeFileSync(
			join(bin, "curl"),
			'#!/bin/sh\nfor a in "$@"; do printf "%s\\n" "$a"; done\nexit "$CURL_EXIT"\n',
		);
		chmodSync(join(bin, "curl"), 0o755);
	});
	afterEach(() => rmSync(bin, { recursive: true, force: true }));

	const runIt = (cmd: string, exit = 0) => {
		try {
			return {
				code: 0,
				out: execFileSync("sh", ["-c", cmd], {
					encoding: "utf8",
					env: {
						PATH: `${bin}:/usr/bin:/bin`,
						CURL_EXIT: String(exit),
					},
				}),
			};
		} catch (error) {
			const e = error as { status: number; stdout: string };
			return { code: e.status, out: e.stdout };
		}
	};

	it("passes curl exactly the header and URL, key included", () => {
		const { code, out } = runIt(watchCommand(ORIGIN, ID, TOKEN, "k3y_-Z9"));
		expect(code).toBe(0);
		expect(out.trim().split("\n")).toEqual([
			"-sfN",
			"-H",
			`Authorization: Bearer ${TOKEN}`,
			`${ORIGIN}/mcp/watch/${ID}?key=k3y_-Z9`,
		]);
	});

	it("no key on a keyless server", () => {
		const { out } = runIt(watchCommand(ORIGIN, ID, TOKEN, null));
		expect(out.trim().split("\n").at(-1)).toBe(`${ORIGIN}/mcp/watch/${ID}`);
	});

	it("an HTTP 4xx (curl 22) ends the loop with exit 3", () => {
		expect(runIt(watchCommand(ORIGIN, ID, TOKEN, null), 22).code).toBe(3);
	});

	it("refuses a key, token, origin or id that could leave the quotes", () => {
		for (const key of ["k'; touch /tmp/pwned; '", "a b", "a$(id)", "", "k\n"]) {
			expect(() => watchCommand(ORIGIN, ID, TOKEN, key), key).toThrow(/key/);
		}
		for (const token of [
			`${ID}.${SECRET.slice(0, -1)}'`,
			`${ID}.${SECRET}' ; id ; '`,
			"x",
			`${"0".repeat(26)}.${SECRET}`.replace(/^0/, "U"),
		]) {
			expect(() => watchCommand(ORIGIN, ID, token, null), token).toThrow(
				/token/,
			);
		}
		for (const origin of [
			"http://evil'$(id)'",
			"http://a b",
			"javascript:alert(1)",
			"http://host/path",
			"http://host:4747?x",
		]) {
			expect(() => watchCommand(origin, ID, TOKEN, null), origin).toThrow(
				/origin/,
			);
		}
		expect(() => watchCommand(ORIGIN, "../etc", TOKEN, null)).toThrow(/id/);
	});

	it("parses only well-formed tokens", () => {
		expect(parseSessionToken(TOKEN)).toEqual({ id: ID, secret: SECRET });
		for (const bad of [undefined, 3, "", `${ID}.short`, `${ID}${SECRET}`]) {
			expect(parseSessionToken(bad)).toBeNull();
		}
	});
});
