import { describe, expect, it } from "vitest";
import { WITHDRAWN_PREFIX, withdrawnReason } from "../src/shared/update";
import {
	laterVersions,
	parseDeprecated,
	planWithdraw,
	type RegistryState,
	sameBugCandidates,
} from "./release-withdraw";

const state = (over: Partial<RegistryState> = {}): RegistryState => ({
	versions: [
		"0.2.0",
		"0.3.0-rc.1",
		"0.3.0",
		"0.4.0-rc.1",
		"0.4.0",
		"0.5.0-rc.0",
		"0.5.0-rc.1",
		"0.5.0-rc.2",
	],
	deprecated: {},
	distTags: { latest: "0.4.0", rc: "0.5.0-rc.2" },
	...over,
});

const NO = { deprecateOnly: false };

describe("withdrawnReason", () => {
	it("the text after the prefix, one line, control and bidi characters replaced", () => {
		expect(withdrawnReason("withdrawn: bad\nthing\u202e")).toBe("bad thing?");
		expect(withdrawnReason("withdrawn: tabs\tand\r\n  spaces ")).toBe(
			"tabs and spaces",
		);
		expect(withdrawnReason(`${WITHDRAWN_PREFIX}<b>x</b>`)).toBe("<b>x</b>");
	});

	it("null for any other deprecation, or a deprecated field that isn't a string", () => {
		expect(withdrawnReason("deprecated for other reasons")).toBe(null);
		expect(withdrawnReason("Withdrawn: wrong case")).toBe(null);
		expect(withdrawnReason(42)).toBe(null);
		expect(withdrawnReason(undefined)).toBe(null);
		expect(withdrawnReason({ reason: "withdrawn: x" })).toBe(null);
		expect(withdrawnReason("")).toBe(null);
	});

	it("at most 300 characters", () => {
		const r = withdrawnReason(`withdrawn: ${"a".repeat(1000)}`);
		expect(r).toHaveLength(300);
		// An astral character is never cut in half.
		const emoji = withdrawnReason(`withdrawn: ${"\u{1F600}".repeat(400)}`);
		expect(Array.from(emoji ?? "")).toHaveLength(300);
	});
});

describe("planWithdraw", () => {
	it("moves latest back to the newest good release, and deprecates with the prefix", () => {
		const plan = planWithdraw(
			state({ distTags: { latest: "0.4.0", rc: "0.4.0" } }),
			["0.4.0"],
			"comments posted to the wrong PR",
			NO,
		);
		expect(plan.refused).toBe(null);
		expect(plan.deprecate).toEqual([
			{
				version: "0.4.0",
				message: "withdrawn: comments posted to the wrong PR",
			},
		]);
		expect(plan.tags).toEqual([
			{ tag: "latest", from: "0.4.0", to: "0.3.0" },
			// Never onto 0.4.0's own RCs (the same code): below them.
			{ tag: "rc", from: "0.4.0", to: "0.3.0" },
		]);
		expect(plan.skipped).toEqual([]);
		expect(plan.alongside).toEqual([]);
	});

	it("a release's promoted RC is withdrawn with it; rc goes below the release's RCs", () => {
		const plan = planWithdraw(
			state({
				versions: ["0.3.0", "0.4.0-rc.0", "0.4.0-rc.1", "0.4.0-rc.2", "0.4.0"],
				distTags: { latest: "0.4.0", rc: "0.4.0" },
			}),
			["0.4.0"],
			"why",
			{ ...NO, promoted: { "0.4.0": "0.4.0-rc.2" } },
		);
		expect(plan.refused).toBe(null);
		expect(plan.alongside).toEqual([
			{ version: "0.4.0-rc.2", release: "0.4.0" },
		]);
		expect(plan.deprecate).toEqual([
			{ version: "0.4.0", message: "withdrawn: why" },
			{ version: "0.4.0-rc.2", message: "withdrawn: why" },
		]);
		expect(plan.tags).toEqual([
			{ tag: "latest", from: "0.4.0", to: "0.3.0" },
			{ tag: "rc", from: "0.4.0", to: "0.3.0" },
		]);
		// rc on the promoted RC itself: moves too.
		const onRc = planWithdraw(
			state({
				versions: ["0.3.0", "0.4.0-rc.1", "0.4.0-rc.2", "0.4.0"],
				distTags: { latest: "0.4.0", rc: "0.4.0-rc.2" },
			}),
			["0.4.0"],
			"why",
			{ ...NO, promoted: { "0.4.0": "0.4.0-rc.2" } },
		);
		expect(onRc.tags).toContainEqual({
			tag: "rc",
			from: "0.4.0-rc.2",
			to: "0.3.0",
		});
		// Withdrawn already (a rerun): skipped, not listed again.
		const rerun = planWithdraw(
			state({
				versions: ["0.3.0", "0.4.0-rc.2", "0.4.0"],
				deprecated: { "0.4.0-rc.2": "withdrawn: why" },
				distTags: { latest: "0.3.0", rc: "0.3.0" },
			}),
			["0.4.0"],
			"why",
			{ ...NO, promoted: { "0.4.0": "0.4.0-rc.2" } },
		);
		expect(rerun.skipped).toEqual(["0.4.0-rc.2"]);
		expect(rerun.deprecate).toEqual([
			{ version: "0.4.0", message: "withdrawn: why" },
		]);
		// A promoted RC npm doesn't have (never published, or no tag): nothing added.
		expect(
			planWithdraw(state(), ["0.4.0"], "why", {
				...NO,
				promoted: { "0.4.0": "0.4.0-rc.9" },
			}).alongside,
		).toEqual([]);
	});

	it("rc never lands on any RC of a release being withdrawn, even an RC not named", () => {
		const plan = planWithdraw(
			state({
				versions: ["0.3.0", "0.4.0-rc.1", "0.4.0", "0.5.0-rc.1"],
				distTags: { latest: "0.4.0", rc: "0.5.0-rc.1" },
			}),
			["0.4.0", "0.5.0-rc.1"],
			"why",
			NO,
		);
		expect(plan.tags).toContainEqual({
			tag: "rc",
			from: "0.5.0-rc.1",
			to: "0.3.0",
		});
	});

	it("rc goes to the newest good version at or below it", () => {
		const plan = planWithdraw(
			state(),
			["0.4.0", "0.5.0-rc.1", "0.5.0-rc.2"],
			"why",
			NO,
		);
		expect(plan.tags).toEqual([
			{ tag: "latest", from: "0.4.0", to: "0.3.0" },
			{ tag: "rc", from: "0.5.0-rc.2", to: "0.5.0-rc.0" },
		]);
		// 0.5.0-rc.0 deprecated already (any reason): further down.
		const down = planWithdraw(
			state({ deprecated: { "0.5.0-rc.0": "old" } }),
			["0.4.0", "0.5.0-rc.1", "0.5.0-rc.2", "0.4.0-rc.1"],
			"why",
			NO,
		);
		expect(down.tags).toContainEqual({
			tag: "rc",
			from: "0.5.0-rc.2",
			to: "0.3.0",
		});
	});

	it("a withdrawn version newest on both tags, nothing good left on rc's line: rc falls back to the newest good release", () => {
		const plan = planWithdraw(
			state({
				versions: ["0.3.0", "0.4.0-rc.1", "0.4.0"],
				distTags: { latest: "0.4.0", rc: "0.4.0" },
			}),
			["0.4.0", "0.4.0-rc.1"],
			"why",
			NO,
		);
		expect(plan.tags).toEqual([
			{ tag: "latest", from: "0.4.0", to: "0.3.0" },
			{ tag: "rc", from: "0.4.0", to: "0.3.0" },
		]);
	});

	it("a half-done rerun finishes only what's missing", () => {
		// Deprecated, tags not moved.
		const tagsLeft = planWithdraw(
			state({ deprecated: { "0.4.0": "withdrawn: why" } }),
			["0.4.0"],
			"why",
			NO,
		);
		expect(tagsLeft.deprecate).toEqual([]);
		expect(tagsLeft.skipped).toEqual(["0.4.0"]);
		expect(tagsLeft.tags).toEqual([
			{ tag: "latest", from: "0.4.0", to: "0.3.0" },
		]);
		// Tags moved, one deprecation missing.
		const oneLeft = planWithdraw(
			state({
				deprecated: { "0.4.0": "withdrawn: why" },
				distTags: { latest: "0.3.0", rc: "0.5.0-rc.0" },
			}),
			["0.4.0", "0.5.0-rc.1"],
			"why",
			NO,
		);
		expect(oneLeft.deprecate).toEqual([
			{ version: "0.5.0-rc.1", message: "withdrawn: why" },
		]);
		expect(oneLeft.skipped).toEqual(["0.4.0"]);
		expect(oneLeft.tags).toEqual([]);
		expect(oneLeft.refused).toBe(null);
	});

	it("a version deprecated for another reason is withdrawn over it", () => {
		const plan = planWithdraw(
			state({ deprecated: { "0.4.0": "use 0.4.1" } }),
			["0.4.0"],
			"why",
			NO,
		);
		expect(plan.deprecate).toEqual([
			{ version: "0.4.0", message: "withdrawn: why" },
		]);
	});

	it("refuses when no good version is left for a tag; --deprecate-only deprecates and moves no tag", () => {
		const only = state({
			versions: ["0.1.0"],
			distTags: { latest: "0.1.0" },
		});
		const plan = planWithdraw(only, ["0.1.0"], "why", NO);
		expect(plan.refused).toMatch(/latest/);
		const forced = planWithdraw(only, ["0.1.0"], "why", {
			deprecateOnly: true,
		});
		expect(forced.refused).toBe(null);
		expect(forced.tags).toEqual([]);
		expect(forced.deprecate).toEqual([
			{ version: "0.1.0", message: "withdrawn: why" },
		]);
	});

	it("refuses a version npm doesn't have, a non-version, no version, or no reason", () => {
		expect(planWithdraw(state(), ["0.9.0"], "why", NO).refused).toMatch(
			/0\.9\.0 is not on npm/,
		);
		expect(planWithdraw(state(), ["latest"], "why", NO).refused).toMatch(
			/not a version/,
		);
		expect(planWithdraw(state(), [], "why", NO).refused).toMatch(/version/);
		expect(planWithdraw(state(), ["0.4.0"], "  ", NO).refused).toMatch(
			/reason/,
		);
	});

	it("refuses a reason that is a version: the reason was forgotten", () => {
		expect(
			planWithdraw(state(), ["0.4.0", "0.5.0-rc.1"], "0.5.0-rc.1", NO).refused,
		).toMatch(/reason.*version/);
		expect(planWithdraw(state(), ["0.4.0"], "v0.3.0", NO).refused).toMatch(
			/reason.*version/,
		);
	});

	it("refuses a reason npm would show on more than one line, or with control or bidi characters", () => {
		expect(planWithdraw(state(), ["0.4.0"], "two\nlines", NO).refused).toMatch(
			/reason/,
		);
		expect(planWithdraw(state(), ["0.4.0"], "x\u202ey", NO).refused).toMatch(
			/reason/,
		);
	});
});

describe("sameBugCandidates", () => {
	it("later versions, and the named release's other RCs, not the named or added ones", () => {
		expect(
			sameBugCandidates(
				state({
					versions: [
						"0.3.0",
						"0.4.0-rc.0",
						"0.4.0-rc.1",
						"0.4.0-rc.2",
						"0.4.0",
						"0.5.0-rc.1",
					],
				}),
				["0.4.0", "0.4.0-rc.2"],
			),
		).toEqual(["0.4.0-rc.0", "0.4.0-rc.1", "0.5.0-rc.1"]);
	});
});

describe("laterVersions", () => {
	it("every version newer than the first named, in semver order", () => {
		expect(
			laterVersions(
				state({
					versions: ["0.5.0-rc.10", "0.4.0", "0.4.1", "0.5.0-rc.2", "0.3.0"],
				}),
				"0.4.0",
			),
		).toEqual(["0.4.1", "0.5.0-rc.2", "0.5.0-rc.10"]);
	});
});

describe("parseDeprecated: npm view's deprecated and version over several versions", () => {
	it("objects (some deprecated), plain versions (none deprecated) or one value", () => {
		expect(
			parseDeprecated([
				{ deprecated: "withdrawn: x", version: "0.4.0" },
				{ version: "0.3.0" },
			]),
		).toEqual({ "0.4.0": "withdrawn: x" });
		expect(parseDeprecated(["0.3.0", "0.4.0"])).toEqual({});
		expect(parseDeprecated({ deprecated: "d", version: "0.4.0" })).toEqual({
			"0.4.0": "d",
		});
		expect(parseDeprecated(undefined)).toEqual({});
		// A deprecated field that isn't a string: not deprecated.
		expect(parseDeprecated([{ deprecated: 1, version: "0.4.0" }])).toEqual({});
	});
});
