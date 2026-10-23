// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Progress } from "../../shared/types";
import { ProgressBar } from "./ProgressBar";

const progress = (
	clusters: Progress["clusters"],
	lines = { total: 0, reviewed: 0, crossedOff: 0 },
	files = { total: 0, reviewed: 0, crossedOff: 0, done: 0 },
): Progress => ({ clusters, lines, files });

describe("ProgressBar", () => {
	afterEach(cleanup);

	it("shows reviewed out of what isn't crossed off, floored", () => {
		render(
			<ProgressBar
				progress={progress(
					{ total: 39, reviewed: 18, crossedOff: 4 },
					{ total: 400, reviewed: 100, crossedOff: 50 },
					{ total: 10, reviewed: 2, crossedOff: 1, done: 3 },
				)}
			/>,
		);
		const clusters = screen.getByRole("progressbar", { name: "Clusters" });
		expect(clusters).toHaveAttribute("aria-valuenow", "51");
		expect(clusters).toHaveTextContent("51%");
		expect(clusters).toHaveTextContent("18 / 35 reviewed");
		const lines = screen.getByRole("progressbar", { name: "Lines" });
		expect(lines).toHaveAttribute("aria-valuenow", "28");
		expect(screen.getByText(/^Left:/)).toHaveTextContent(
			"Left: 17 clusters · 250 lines · 7 files",
		);
		expect(screen.getByText(/^Crossed off, not reviewed:/)).toHaveTextContent(
			"Crossed off, not reviewed: 4 clusters · 50 lines · 1 files",
		);
	});

	it("shows 100% when everything is crossed off", () => {
		render(
			<ProgressBar
				progress={progress({ total: 2, reviewed: 0, crossedOff: 2 })}
			/>,
		);
		expect(
			screen.getByRole("progressbar", { name: "Clusters" }),
		).toHaveAttribute("aria-valuenow", "100");
	});
});
