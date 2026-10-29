// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Progress } from "../../shared/types";
import { Meter, ProgressBar } from "./ProgressBar";

const sample: Progress = {
	clusters: { total: 39, reviewed: 18, crossedOff: 4 },
	lines: { total: 400, reviewed: 100, crossedOff: 50 },
	files: { total: 10, reviewed: 2, crossedOff: 1, done: 3 },
};

describe("ProgressBar", () => {
	afterEach(cleanup);

	it("shows one bar in the selected unit", () => {
		const { rerender } = render(
			<ProgressBar progress={sample} unit="lines" onUnitChange={() => {}} />,
		);
		const bars = screen.getAllByRole("progressbar");
		expect(bars).toHaveLength(1);
		const bar = screen.getByRole("progressbar", { name: "Review progress" });
		expect(bar).toHaveAttribute("aria-valuenow", "28");
		expect(bar).toHaveTextContent("28%");
		expect(bar).toHaveTextContent("100 / 350 lines reviewed");

		rerender(
			<ProgressBar progress={sample} unit="clusters" onUnitChange={() => {}} />,
		);
		expect(bar).toHaveAttribute("aria-valuenow", "51");
		expect(bar).toHaveTextContent("18 / 35 clusters reviewed");

		rerender(
			<ProgressBar progress={sample} unit="files" onUnitChange={() => {}} />,
		);
		expect(bar).toHaveAttribute("aria-valuenow", "22");
		expect(bar).toHaveTextContent("2 / 9 files reviewed");
	});

	it("names the unit in the singular for one", () => {
		const one: Progress = {
			clusters: { total: 1, reviewed: 0, crossedOff: 0 },
			lines: { total: 2, reviewed: 1, crossedOff: 1 },
			files: { total: 1, reviewed: 0, crossedOff: 0, done: 0 },
		};
		const { rerender } = render(
			<ProgressBar progress={one} unit="files" onUnitChange={() => {}} />,
		);
		const bar = screen.getByRole("progressbar", { name: "Review progress" });
		expect(bar).toHaveTextContent("0 / 1 file reviewed");
		rerender(
			<ProgressBar progress={one} unit="lines" onUnitChange={() => {}} />,
		);
		expect(bar).toHaveTextContent("1 / 1 line reviewed");
		rerender(
			<ProgressBar
				progress={{
					...one,
					clusters: { total: 1, reviewed: 0, crossedOff: 1 },
				}}
				unit="clusters"
				onUnitChange={() => {}}
			/>,
		);
		expect(bar).toHaveAttribute(
			"aria-valuetext",
			"Nothing left to review: 1 cluster crossed off, 0 reviewed",
		);
	});

	it("has no crossed-off legend line", () => {
		render(
			<ProgressBar progress={sample} unit="lines" onUnitChange={() => {}} />,
		);
		expect(screen.queryByText(/Crossed off, not reviewed/)).toBeNull();
	});

	it("chooses the unit", async () => {
		const onUnitChange = vi.fn();
		render(
			<ProgressBar
				progress={sample}
				unit="lines"
				onUnitChange={onUnitChange}
			/>,
		);
		expect(screen.getByRole("radio", { name: "Lines" })).toBeChecked();
		await userEvent.click(screen.getByRole("radio", { name: "Files" }));
		expect(onUnitChange).toHaveBeenCalledWith("files");
	});

	it("says nothing is left to review when everything is crossed off", () => {
		render(
			<ProgressBar
				progress={{
					clusters: { total: 2, reviewed: 0, crossedOff: 2 },
					lines: { total: 4, reviewed: 0, crossedOff: 4 },
					files: { total: 1, reviewed: 0, crossedOff: 1, done: 1 },
				}}
				unit="clusters"
				onUnitChange={() => {}}
			/>,
		);
		const bar = screen.getByRole("progressbar", { name: "Review progress" });
		expect(bar).toHaveAttribute("aria-valuenow", "100");
		expect(bar).toHaveTextContent("Nothing left to review");
		expect(bar).not.toHaveTextContent("100%");
		expect(bar).toHaveAttribute(
			"aria-valuetext",
			"Nothing left to review: 2 clusters crossed off, 0 reviewed",
		);
	});

	it("keeps the gap for unreviewed work without emptying a segment", () => {
		const width = (name: string) =>
			Number.parseFloat(
				document.querySelector<HTMLElement>(`[data-part="${name}"]`)?.style
					.width ?? "NaN",
			);
		// 7 reviewed, 395 crossed off, 11 left: the gap's 3.3 points used to
		// come out of the 1.7-point reviewed segment first, leaving no green
		// at all under a "38%".
		const { rerender } = render(
			<Meter
				counts={{ total: 413, reviewed: 7, crossedOff: 395 }}
				incomplete
			/>,
		);
		expect(width("reviewed")).toBeGreaterThan(1);
		expect(width("crossed-off")).toBeGreaterThan(90);
		expect(width("reviewed") + width("crossed-off")).toBeCloseTo(94, 5);
		// The mirror: two crossed off beside 95 reviewed keep their hatch.
		rerender(
			<Meter counts={{ total: 100, reviewed: 95, crossedOff: 2 }} incomplete />,
		);
		expect(width("crossed-off")).toBeGreaterThan(1);
		expect(width("reviewed")).toBeGreaterThan(90);
		expect(width("reviewed") + width("crossed-off")).toBeCloseTo(94, 5);
		// Room for the gap already: nothing moves.
		rerender(
			<Meter
				counts={{ total: 100, reviewed: 50, crossedOff: 20 }}
				incomplete
			/>,
		);
		expect(width("reviewed")).toBe(50);
		expect(width("crossed-off")).toBe(20);
		// Nothing left: the counts are drawn as they are.
		rerender(<Meter counts={{ total: 100, reviewed: 98, crossedOff: 2 }} />);
		expect(width("reviewed")).toBe(98);
		expect(width("crossed-off")).toBe(2);
	});

	it("says when clusters without changed lines are left", () => {
		render(
			<ProgressBar
				progress={{
					clusters: { total: 2, reviewed: 1, crossedOff: 0 },
					lines: { total: 4, reviewed: 4, crossedOff: 0 },
					files: { total: 2, reviewed: 1, crossedOff: 0, done: 1 },
				}}
				unit="lines"
				onUnitChange={() => {}}
			/>,
		);
		const bar = screen.getByRole("progressbar", { name: "Review progress" });
		expect(bar).toHaveAttribute("aria-valuenow", "99");
		expect(bar).toHaveAttribute(
			"aria-valuetext",
			"99%, 4 / 4 lines reviewed, 1 cluster without changed lines left",
		);
		// The meter keeps a gap open: it never looks full.
		const reviewed = bar.querySelector<HTMLElement>('[data-part="reviewed"]');
		expect(Number.parseFloat(reviewed?.style.width ?? "100")).toBeLessThan(100);
		expect(
			screen.getByText("1 cluster without changed lines left"),
		).toBeInTheDocument();
	});
});
