import { describe, expect, it } from "vitest";
import { parseMoveBody } from "./moveBody";
import { InvalidPlacementError } from "./threads";

/*
 * The move route's own checks (POST /moves), before the session checks the
 * thread and the anchor against the target's files: each case fails when
 * only its check is removed.
 */

const anchor = {
	path: "src/a.ts",
	startSide: "RIGHT",
	startLine: 2,
	side: "RIGHT",
	line: 4,
};
const github = { source: "github", id: "PRRT_kwDOabc" };
const agent = { source: "agent", id: "01jabcdefghjkmnpqrstvwxyz0" };
const head = "a".repeat(40);
const ok = { thread: github, to: { patchset: 2 }, anchor };

describe("parseMoveBody", () => {
	it("takes a thread, a target and an anchor, and keeps only their fields", () => {
		expect(
			parseMoveBody({
				thread: { ...github, extra: 1 },
				to: { patchset: 2 },
				anchor: { ...anchor, extra: "<x>" },
				on: { base: "b".repeat(40), head: "c".repeat(40) },
			}),
		).toEqual({ thread: github, to: { patchset: 2 }, anchor });
		expect(parseMoveBody({ ...ok, thread: agent, to: { head } })).toEqual({
			thread: agent,
			to: { head },
			anchor,
		});
	});

	it("never takes the snapshot from the body", () => {
		const parsed = parseMoveBody({
			...ok,
			on: { base: "b".repeat(40), head: "c".repeat(40), patchset: 9 },
		}) as unknown as Record<string, unknown>;
		expect(parsed.on).toBeUndefined();
	});

	it.each([
		["no body", null],
		["a body that is no object", "2"],
		["no thread", { to: { patchset: 2 }, anchor }],
		["an unknown source", { ...ok, thread: { source: "gitlab", id: "x" } }],
		[
			"an agent id that is no ULID",
			{ ...ok, thread: { source: "agent", id: "PRRT_1" } },
		],
		[
			"an uppercase agent ULID",
			{ ...ok, thread: { source: "agent", id: agent.id.toUpperCase() } },
		],
		["an empty GitHub id", { ...ok, thread: { source: "github", id: "" } }],
		[
			"a GitHub id past 200 characters",
			{ ...ok, thread: { source: "github", id: "x".repeat(201) } },
		],
		["no target", { thread: github, anchor }],
		["both targets", { ...ok, to: { patchset: 2, head } }],
		["patch set 0", { ...ok, to: { patchset: 0 } }],
		["a head that is no commit id", { ...ok, to: { head: "HEAD" } }],
		["a head with a newline", { ...ok, to: { head: `${head}\n` } }],
		["no anchor", { thread: github, to: { patchset: 2 } }],
		["an empty path", { ...ok, anchor: { ...anchor, path: "" } }],
		["a path that is no string", { ...ok, anchor: { ...anchor, path: 7 } }],
		[
			"a path past 4 KiB",
			{ ...ok, anchor: { ...anchor, path: "é".repeat(2049) } },
		],
		["a side that is none", { ...ok, anchor: { ...anchor, side: "UP" } }],
		[
			"a start side that is none",
			{ ...ok, anchor: { ...anchor, startSide: 1 } },
		],
		["line 0", { ...ok, anchor: { ...anchor, line: 0 } }],
		[
			"a fractional start line",
			{ ...ok, anchor: { ...anchor, startLine: 1.5 } },
		],
		["a line as a string", { ...ok, anchor: { ...anchor, line: "4" } }],
		["a line past 2^31", { ...ok, anchor: { ...anchor, line: 2 ** 31 } }],
		["a start after its end", { ...ok, anchor: { ...anchor, startLine: 5 } }],
	])("refuses %s", (_, body) => {
		expect(() => parseMoveBody(body)).toThrow(InvalidPlacementError);
	});
});
