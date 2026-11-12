import { describe, expect, it } from "vitest";
import { channelOf, compareVersions, isNewer, parseVersion } from "./semver";

describe("semver", () => {
	it("parses releases and prereleases, nothing else", () => {
		expect(parseVersion("0.2.0")).toEqual({
			major: 0,
			minor: 2,
			patch: 0,
			pre: [],
		});
		expect(parseVersion("1.2.3-rc.10")?.pre).toEqual(["rc", "10"]);
		for (const bad of ["1.2", "v1.2.3", "01.2.3", "1.2.3+build", "", null, 3]) {
			expect(parseVersion(bad)).toBeNull();
		}
	});

	it("orders by precedence: numbers numerically, a release after its RCs", () => {
		const sorted = [
			"0.1.0",
			"0.2.0-rc.1",
			"0.2.0-rc.2",
			"0.2.0-rc.10",
			"0.2.0",
			"0.2.1",
			"0.10.0",
			"1.0.0-alpha",
			"1.0.0-alpha.1",
			"1.0.0-beta",
			"1.0.0",
		];
		const parsed = sorted.map((v) => parseVersion(v));
		for (let i = 1; i < parsed.length; i++) {
			// biome-ignore lint/style/noNonNullAssertion: all parse.
			expect(compareVersions(parsed[i - 1]!, parsed[i]!)).toBeLessThan(0);
			// biome-ignore lint/style/noNonNullAssertion: all parse.
			expect(compareVersions(parsed[i]!, parsed[i]!)).toBe(0);
		}
	});

	it("only strictly newer counts", () => {
		expect(isNewer("0.2.0", "0.1.0")).toBe(true);
		expect(isNewer("0.2.0", "0.2.0-rc.3")).toBe(true);
		expect(isNewer("0.2.0-rc.4", "0.2.0-rc.3")).toBe(true);
		expect(isNewer("0.2.0", "0.2.0")).toBe(false);
		expect(isNewer("0.1.9", "0.2.0")).toBe(false);
		expect(isNewer("0.2.0-rc.1", "0.2.0")).toBe(false);
		expect(isNewer("garbage", "0.1.0")).toBe(false);
		expect(isNewer("0.2.0", "garbage")).toBe(false);
	});

	it("a prerelease follows rc, a release latest", () => {
		expect(channelOf("0.2.0-rc.1")).toBe("rc");
		expect(channelOf("0.2.0")).toBe("latest");
	});
});
