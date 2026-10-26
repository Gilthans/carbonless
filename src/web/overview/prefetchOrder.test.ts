import { describe, expect, it } from "vitest";
import { prefetchOrder } from "./prefetchOrder";

const t = (id: string, more: { unavailable?: "deleted" } = {}) => ({
	id,
	...more,
});

describe("prefetchOrder", () => {
	it("puts every group's visible threads first, then their next pages, then the rest", () => {
		const all = ["h1", "h2", "h3", "h4", "b1", "b2", "b3", "r1"].map((id) =>
			t(id),
		);
		expect(
			prefetchOrder(all, [
				{ visible: ["h1", "h2"], next: ["h3"] },
				{ visible: ["b1"], next: ["b2"] },
			]),
		).toEqual(["h1", "h2", "b1", "h3", "b2", "h4", "b3", "r1"]);
	});

	it("lists all threads before any group says what it shows", () => {
		expect(prefetchOrder([t("a"), t("b")], [])).toEqual(["a", "b"]);
	});

	it("leaves out threads with no id or whose text will never come, and repeats none", () => {
		expect(
			prefetchOrder(
				[t("a"), t(""), t("d", { unavailable: "deleted" }), t("b")],
				[{ visible: ["b", "", "d"], next: ["a", "b"] }],
			),
		).toEqual(["b", "a"]);
	});

	it("never asks for an id that isn't a thread of the list", () => {
		expect(prefetchOrder([t("a")], [{ visible: ["gone"], next: [] }])).toEqual([
			"a",
		]);
	});
});
