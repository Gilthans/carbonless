import { execFileSync } from "node:child_process";
import {
	chmodSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GIT_TEST_TIMEOUTS } from "../../../test/git-fixture";
import {
	parseSessionToken,
	sessionToken,
	UnsafeKeyError,
	WATCH_TRIES,
	watchCommand,
} from "./watch";

// Each loop runs sh, curl, grep and sed processes (a hundred or more per test).
vi.setConfig(GIT_TEST_TIMEOUTS);

const ID = "01k9e6m2q8x4v7c3n5b0h1j2t6";
const SECRET = "A".repeat(20) + "b_-".repeat(7) + "z".repeat(2);
const TOKEN = sessionToken(ID, SECRET);
const ORIGIN = "http://100.64.1.2:4747";

describe("the watch command", () => {
	let bin: string;
	beforeEach(() => {
		// A curl that records its arguments, then plays the next line of
		// $PLAN ("<exit> [text]"): two keep-alive newlines, the text, the exit.
		// A sleep that returns at once.
		bin = mkdtempSync(join(tmpdir(), "crb-watch-"));
		writeFileSync(
			join(bin, "curl"),
			[
				"#!/bin/sh",
				'printf "%s\\n" "$@" > "$ARGS"',
				'n=$(cat "$COUNT" 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > "$COUNT"',
				'step=$(sed -n "$n"p "$PLAN")',
				'code=$(echo "$step" | cut -d" " -f1); text=$(echo "$step" | cut -s -d" " -f2-)',
				"printf '\\n\\n'",
				'[ -n "$text" ] && printf "%s\\n" "$text"',
				'exit "$code"',
				"",
			].join("\n"),
		);
		writeFileSync(join(bin, "sleep"), "#!/bin/sh\nexit 0\n");
		chmodSync(join(bin, "curl"), 0o755);
		chmodSync(join(bin, "sleep"), 0o755);
	});
	afterEach(() => rmSync(bin, { recursive: true, force: true }));

	/** Runs the line against a plan of curl ends; its exit, stdout and curl's calls. */
	const runIt = (cmd: string, plan: string[]) => {
		writeFileSync(join(bin, "plan"), `${plan.join("\n")}\n`);
		const env = {
			PATH: `${bin}:/usr/bin:/bin`,
			PLAN: join(bin, "plan"),
			COUNT: join(bin, "count"),
			ARGS: join(bin, "args"),
		};
		let code = 0;
		let out = "";
		try {
			out = execFileSync("sh", ["-c", cmd], { encoding: "utf8", env });
		} catch (error) {
			const e = error as { status: number; stdout: string };
			code = e.status;
			out = e.stdout;
		}
		const calls = Number(readFileSync(env.COUNT, "utf8").trim());
		const args = readFileSync(env.ARGS, "utf8").trimEnd().split("\n");
		return { code, out, calls, args };
	};
	const LINE = "carbonless: a question is waiting on acme/widget#12.";
	const cmd = (key: string | null = null) =>
		watchCommand(ORIGIN, ID, TOKEN, key);

	it("passes curl exactly the header and URL, key included", () => {
		const { args } = runIt(cmd("k3y_-Z9"), [`0 ${LINE}`]);
		expect(args).toEqual([
			"-sfN",
			"-H",
			`Authorization: Bearer ${TOKEN}`,
			`${ORIGIN}/mcp/watch/${ID}?key=k3y_-Z9`,
		]);
	});

	it("no key on a keyless server", () => {
		const { args } = runIt(cmd(), [`0 ${LINE}`]);
		expect(args.at(-1)).toBe(`${ORIGIN}/mcp/watch/${ID}`);
	});

	it("crb's line: printed alone (no keep-alives), exit 0", () => {
		const r = runIt(cmd(), [`0 ${LINE}`]);
		expect(r).toMatchObject({ code: 0, out: `${LINE}\n`, calls: 1 });
	});

	it("an HTTP 4xx (curl 22) ends the loop with exit 3, printing nothing", () => {
		expect(runIt(cmd(), ["22"])).toMatchObject({ code: 3, out: "", calls: 1 });
	});

	it("refused or timed-out connects in a row give up (exit 4)", () => {
		const plan = Array.from({ length: WATCH_TRIES + 5 }, (_, i) =>
			i % 2 ? "7" : "28",
		);
		expect(runIt(cmd(), plan)).toMatchObject({
			code: 4,
			out: "",
			calls: WATCH_TRIES,
		});
	});

	it("dropped streams (crb restarting) never add up: it keeps reconnecting", () => {
		const plan = [
			...Array.from({ length: 5 }, () => "18"),
			...Array.from({ length: WATCH_TRIES - 1 }, () => "7"),
			"52",
			...Array.from({ length: WATCH_TRIES - 1 }, () => "7"),
			`0 ${LINE}`,
		];
		expect(runIt(cmd(), plan)).toMatchObject({
			code: 0,
			out: `${LINE}\n`,
			calls: plan.length,
		});
	});

	it("refuses a key, token, origin or id that could leave the quotes", () => {
		for (const key of ["k'; touch /tmp/pwned; '", "a b", "a$(id)", "", "k\n"]) {
			expect(() => watchCommand(ORIGIN, ID, TOKEN, key), key).toThrow(
				UnsafeKeyError,
			);
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
