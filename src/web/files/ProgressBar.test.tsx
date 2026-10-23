// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Progress } from "../../shared/types";
import { ProgressBar } from "./ProgressBar";

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

	it("shows 100% when everything is crossed off", () => {
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
		expect(
			screen.getByRole("progressbar", { name: "Review progress" }),
		).toHaveAttribute("aria-valuenow", "100");
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
		expect(
			screen.getByText("1 cluster without changed lines left"),
		).toBeInTheDocument();
	});
});
