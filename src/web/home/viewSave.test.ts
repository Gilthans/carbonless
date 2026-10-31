import { describe, expect, it } from "vitest";
import { ago, row, view } from "./testing";
import { pendingView } from "./viewSave";

const started = (owner: string, repo: string, number: number) =>
	row({
		owner,
		repo,
		number,
		reviews: [
			{
				id: `R${number}`,
				label: "head",
				pinnedHead: null,
				coverage: { done: 1, total: 2, unit: "lines" },
				lastActedAt: ago(5),
				headMoved: false,
			},
		],
	});

describe("pendingView", () => {
	it("lists the saving repos and drops the rows of removed ones, as the server will", () => {
		const home = view({
			mine: [row({ number: 1 }), row({ repo: "console", number: 2 })],
			other: [row({ owner: "Acme", repo: "Console", number: 3 })],
		});
		const shown = pendingView(home, ["acme/api", "acme/web"]);
		expect(shown.view.repos).toEqual(["acme/api", "acme/web"]);
		const numbers = shown.sections.flatMap((s) => s.rows.map((r) => r.number));
		expect(numbers).toEqual([1]);
		// The rest stays the server's.
		expect(shown.viewer).toBe(home.viewer);
		expect(shown.sections.map((s) => s.id)).toEqual(
			home.sections.map((s) => s.id),
		);
	});

	it("keeps a started PR of a removed repo: Home lists started PRs from any repo", () => {
		const home = view({ reviewing: [started("acme", "console", 4)] });
		const shown = pendingView(home, ["acme/api"]);
		expect(shown.sections.flatMap((s) => s.rows).map((r) => r.number)).toEqual([
			4,
		]);
	});

	it("compares repos without case", () => {
		const home = view({ mine: [row({ owner: "ACME", repo: "Api" })] });
		expect(
			pendingView(home, ["acme/api"]).sections.flatMap((s) => s.rows),
		).toHaveLength(1);
	});
});
