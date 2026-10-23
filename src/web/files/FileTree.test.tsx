// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClusterState, FileView } from "../../shared/types";
import { FileTree } from "./FileTree";

function file(
	index: number,
	path: string,
	states: ClusterState[],
	reason?: string,
): FileView {
	const clusters = states.map((state, i) => ({
		key: `${index}:${i}`,
		kind: "lines" as const,
		oldStart: 1,
		oldCount: 1,
		newStart: 1,
		newCount: 1,
		removed: ["a"],
		added: ["b"],
		lines: 2,
		state,
		...(state === "crossed-off" ? { reason } : {}),
	}));
	return {
		index,
		path,
		status: "modified",
		binary: false,
		submodule: false,
		additions: 3,
		deletions: 1,
		clusters,
		done: states.every((s) => s !== "unreviewed"),
		crossedOff: states.every((s) => s === "crossed-off"),
	};
}

const files = [
	file(0, "src/a/deep/one.ts", ["reviewed", "unreviewed"]),
	file(1, "src/a/deep/two.ts", ["reviewed"]),
	file(2, "src/b.ts", ["unreviewed"]),
	file(3, "gen/api.g.cs", ["crossed-off", "crossed-off"], "generated"),
];

describe("FileTree", () => {
	afterEach(cleanup);

	it("nests files under folders, in snapshot order, with their status", () => {
		render(
			<FileTree
				files={files}
				unit="clusters"
				current={2}
				onSelect={() => {}}
			/>,
		);
		const tree = screen.getByTestId("file-tree");
		expect(within(tree).getByText("src")).toBeInTheDocument();
		expect(within(tree).getByText("a/deep")).toBeInTheDocument();
		const items = within(tree)
			.getAllByRole("button")
			.map((b) => b.textContent);
		expect(items.map((t) => t?.match(/one|two|b\.ts|api/)?.[0])).toEqual([
			"one",
			"two",
			"b.ts",
			"api",
		]);
		const one = within(tree).getByRole("button", { name: /one\.ts/ });
		expect(one).toHaveTextContent("1 / 2");
		expect(one).toHaveTextContent("+3");
		expect(
			within(one).getByRole("img", { name: "partly done" }),
		).toBeInTheDocument();
		expect(
			within(within(tree).getByRole("button", { name: /two\.ts/ })).getByRole(
				"img",
				{
					name: "done",
				},
			),
		).toBeInTheDocument();
		expect(within(tree).getByRole("button", { name: /b\.ts/ })).toHaveAttribute(
			"aria-current",
			"true",
		);
	});

	it("strikes crossed-off files through and tags them with the reason", () => {
		render(
			<FileTree
				files={files}
				unit="clusters"
				current={null}
				onSelect={() => {}}
			/>,
		);
		const gen = screen.getByRole("button", { name: /api\.g\.cs/ });
		expect(within(gen).getByText("api.g.cs").closest("s")).not.toBeNull();
		expect(gen).toHaveTextContent("generated");
		expect(
			within(gen).getByRole("img", { name: "crossed off" }),
		).toBeInTheDocument();
	});

	it("counts in the selected unit", () => {
		const { rerender } = render(
			<FileTree
				files={files}
				unit="lines"
				current={null}
				onSelect={() => {}}
			/>,
		);
		const one = () => screen.getByRole("button", { name: /one\.ts/ });
		expect(one()).toHaveTextContent("2 / 4");
		rerender(
			<FileTree
				files={files}
				unit="files"
				current={null}
				onSelect={() => {}}
			/>,
		);
		expect(one()).toHaveTextContent("0 / 1");
		expect(screen.getByRole("button", { name: /two\.ts/ })).toHaveTextContent(
			"done",
		);
		expect(
			screen.getByRole("button", { name: /api\.g\.cs/ }),
		).toHaveTextContent("crossed off");
	});

	it("selects a file", async () => {
		const onSelect = vi.fn();
		render(
			<FileTree
				files={files}
				unit="clusters"
				current={null}
				onSelect={onSelect}
			/>,
		);
		await userEvent.click(screen.getByRole("button", { name: /two\.ts/ }));
		expect(onSelect).toHaveBeenCalledWith(1);
	});
});
