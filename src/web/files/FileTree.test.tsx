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
		reviewed: states.every((s) => s === "reviewed"),
		crossedOff: states.every((s) => s === "crossed-off"),
	};
}

const bar = (row: HTMLElement) =>
	within(row).getByRole("progressbar", { name: "File progress" });
/** A meter part's width in percent. */
const part = (meter: HTMLElement, name: string) =>
	Number.parseFloat(
		meter.querySelector<HTMLElement>(`[data-part="${name}"]`)?.style.width ??
			"NaN",
	);

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
		expect(bar(one)).toHaveAttribute(
			"aria-valuetext",
			"1 of 2 clusters reviewed",
		);
		expect(one).not.toHaveTextContent("1 / 2");
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

	it("shows progress as a mini bar with the exact numbers on hover and focus", () => {
		render(
			<FileTree
				files={files}
				unit="clusters"
				current={null}
				onSelect={() => {}}
			/>,
		);
		const one = bar(screen.getByRole("button", { name: /one\.ts/ }));
		expect(one).toHaveAttribute("title", "1 of 2 clusters reviewed");
		expect(one).toHaveAttribute("aria-valuenow", "50");
		expect(part(one, "reviewed")).toBe(50);
		const gen = bar(screen.getByRole("button", { name: /api\.g\.cs/ }));
		expect(gen).toHaveAttribute("aria-valuetext", "crossed off");
		expect(part(gen, "crossed-off")).toBe(100);
		// The bar is the row's last part, so bars line up down the tree.
		const row = screen.getByRole("button", { name: /one\.ts/ });
		expect(row.lastElementChild).toBe(one);
	});

	it("never shows a file's bar full while anything in it is unreviewed", () => {
		const renamed: FileView = {
			...file(5, "docs/new.md", ["reviewed", "unreviewed"]),
		};
		const [edit, rename] = renamed.clusters as [
			FileView["clusters"][number],
			FileView["clusters"][number],
		];
		renamed.clusters = [edit, { ...rename, kind: "file", lines: 0 }];
		render(
			<FileTree
				files={[renamed]}
				unit="lines"
				current={null}
				onSelect={() => {}}
			/>,
		);
		const b = bar(screen.getByRole("button", { name: /new\.md/ }));
		expect(b).toHaveAttribute("aria-valuenow", "99");
		expect(b.getAttribute("aria-valuetext")).toMatch(
			/1 cluster without changed lines left/,
		);
		expect(part(b, "reviewed")).toBeLessThan(100);
	});

	it("counts changes in the selected unit", () => {
		const { rerender } = render(
			<FileTree
				files={files}
				unit="lines"
				current={null}
				onSelect={() => {}}
			/>,
		);
		const one = () => screen.getByRole("button", { name: /one\.ts/ });
		expect(one()).toHaveTextContent("+3 −1");
		expect(bar(one())).toHaveAttribute(
			"aria-valuetext",
			"2 of 4 lines reviewed",
		);
		rerender(
			<FileTree
				files={files}
				unit="clusters"
				current={null}
				onSelect={() => {}}
			/>,
		);
		expect(one()).not.toHaveTextContent("+3");
		const count = within(one()).getByRole("img", { name: "2 clusters" });
		expect(count).toHaveTextContent("2");
		expect(count).toHaveAttribute("title", "2 clusters");
		expect(
			within(screen.getByRole("button", { name: /two\.ts/ })).getByRole("img", {
				name: "1 cluster",
			}),
		).toBeInTheDocument();
		rerender(
			<FileTree
				files={files}
				unit="files"
				current={null}
				onSelect={() => {}}
			/>,
		);
		expect(one()).not.toHaveTextContent("+3");
		expect(within(one()).queryByRole("img", { name: /clusters?$/ })).toBeNull();
		expect(bar(one())).toHaveAttribute(
			"aria-valuetext",
			"0 of 1 files reviewed",
		);
		expect(
			bar(screen.getByRole("button", { name: /two\.ts/ })),
		).toHaveAttribute("aria-valuetext", "done");
	});

	it("describes a file without changed lines by its status in lines", () => {
		const rename: FileView = {
			...file(4, "docs/new.md", ["unreviewed"]),
			clusters: [
				{
					...(file(4, "x", ["unreviewed"])
						.clusters[0] as FileView["clusters"][number]),
					kind: "file",
					lines: 0,
				},
			],
		};
		render(
			<FileTree
				files={[rename]}
				unit="lines"
				current={null}
				onSelect={() => {}}
			/>,
		);
		const entry = bar(screen.getByRole("button", { name: /new\.md/ }));
		expect(entry).toHaveAttribute("aria-valuetext", "1 cluster left");
		expect(entry).toHaveAttribute("aria-valuenow", "0");
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
