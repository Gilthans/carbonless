import { describe, expect, it } from "vitest";
import { parseFilesSearch } from "./files/landing";
import { parseOpeningSearch } from "./OpeningPage";
import { parseSearch, stringifySearch } from "./search";

describe("search params", () => {
	it("keeps every value as the string in the address: a digit-only SHA, a numeric path", () => {
		expect(parseSearch("?head=1234567&path=123&line=12&moved=true")).toEqual({
			head: "1234567",
			path: "123",
			line: "12",
			moved: "true",
		});
		expect(parseSearch("?head=1234567e1")).toEqual({ head: "1234567e1" });
		expect(parseOpeningSearch(parseSearch("?head=1234567"))).toEqual({
			head: "1234567",
		});
		expect(parseFilesSearch(parseSearch("?path=123&line=4"))).toEqual({
			path: "123",
			line: 4,
		});
	});

	it("reads a JSON-quoted string as its text (links the router wrote before)", () => {
		expect(parseSearch("?path=%22123%22")).toEqual({ path: "123" });
	});

	it("round-trips what the app puts in its links", () => {
		for (const search of [
			{ path: "123", line: 7, side: "LEFT", moved: true },
			{ path: '"quoted"' },
			{ head: "1234567" },
		]) {
			const back = parseSearch(stringifySearch(search));
			expect(parseFilesSearch(back)).toEqual(parseFilesSearch(search));
			if ("head" in search) expect(back).toEqual(search);
			if ("path" in search) expect(back.path).toBe(search.path);
		}
		expect(stringifySearch({})).toBe("");
		expect(stringifySearch({ a: undefined, b: "x y" })).toBe("?b=x+y");
	});
});
