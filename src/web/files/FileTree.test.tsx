// @vitest-environment jsdom
import {
	cleanup,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
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

/** The row's mini bar (decorative: the numbers are in the row's name). */
const bar = (row: HTMLElement) =>
	row.querySelector<HTMLElement>('[data-testid="tree-meter"]') as HTMLElement;
/** The exact numbers, as they end the row's accessible name. */
const numbers = (row: HTMLElement) =>
	row.querySelector('[data-testid="tree-numbers"]')?.textContent;
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

	it("tints finished rows green, crossed off ones too, and no others", () => {
		render(
			<FileTree
				files={files}
				unit="clusters"
				current={null}
				onSelect={() => {}}
			/>,
		);
		const row = (name: string) =>
			screen.getByRole("button", { name: new RegExp(name) });
		for (const name of ["two\\.ts", "api\\.g\\.cs"]) {
			expect(row(name), name).toHaveAttribute("data-finished");
			expect(row(name).className, name).toContain("bg-ok/8");
		}
		for (const name of ["one\\.ts", "b\\.ts"]) {
			expect(row(name), name).not.toHaveAttribute("data-finished");
			expect(row(name).className, name).not.toContain("bg-ok");
		}
		// The crossed-off file keeps its purple strike-through.
		expect(row("api\\.g\\.cs").querySelector("s")).not.toBeNull();
	});

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
		const folders = (name: string) =>
			within(tree).getAllByText(name, { selector: ":not([role=tooltip])" });
		expect(folders("src")).toHaveLength(1);
		expect(folders("a/deep")).toHaveLength(1);
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
		expect(numbers(one)).toBe("1 of 2 clusters reviewed");
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
		const row = screen.getByRole("button", { name: /one\.ts/ });
		expect(row).toHaveAccessibleName(/one\.ts.*1 of 2 clusters reviewed$/);
		// No progressbar inside the button: the name carries the numbers.
		expect(within(row).queryByRole("progressbar")).toBeNull();
		const one = bar(row);
		expect(one).toHaveAttribute("aria-hidden", "true");
		expect(part(one, "reviewed")).toBe(50);
		const gen = screen.getByRole("button", { name: /api\.g\.cs/ });
		expect(numbers(gen)).toBe("crossed off");
		expect(part(bar(gen), "crossed-off")).toBe(100);
		// The bar is the row's last visible part, so bars line up down the tree.
		expect(row.lastElementChild).toBe(one);
	});

	it("shows the exact numbers in a tooltip on keyboard focus and hover", async () => {
		const user = userEvent.setup();
		render(
			<FileTree
				files={files}
				unit="clusters"
				current={null}
				onSelect={() => {}}
			/>,
		);
		// Decorative for screen readers (the numbers are in the row's name),
		// so found by the DOM rather than by role.
		const shown = () =>
			[...document.querySelectorAll('[role="tooltip"]')].filter(
				(t) => !t.hasAttribute("hidden"),
			);
		expect(shown()).toHaveLength(0);
		await user.tab();
		const first = screen.getByRole("button", { name: /one\.ts/ });
		expect(first).toHaveFocus();
		expect(shown()).toHaveLength(1);
		expect(shown()[0]).toHaveTextContent("1 of 2 clusters reviewed");
		await user.tab();
		expect(screen.getByRole("button", { name: /two\.ts/ })).toHaveFocus();
		expect(shown()).toHaveLength(1);
		expect(shown()[0]).toHaveTextContent("1 of 1 cluster reviewed");
		await user.keyboard("{Escape}");
		expect(shown()).toHaveLength(0);
		await user.click(document.body);
		await user.hover(screen.getByRole("button", { name: /api\.g\.cs/ }));
		await waitFor(() => expect(shown()).toHaveLength(1));
		expect(shown()[0]).toHaveTextContent("crossed off");
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
		const row = screen.getByRole("button", { name: /new\.md/ });
		expect(numbers(row)).toMatch(/1 cluster without changed lines left/);
		expect(part(bar(row), "reviewed")).toBeLessThan(100);
	});

	it("shows the same change counts in every unit; only progress follows it", () => {
		const progress: Record<string, string> = {
			lines: "2 of 4 lines reviewed",
			clusters: "1 of 2 clusters reviewed",
			files: "0 of 1 file reviewed",
		};
		const one = () => screen.getByRole("button", { name: /one\.ts/ });
		const { rerender } = render(
			<FileTree
				files={files}
				unit="lines"
				current={null}
				onSelect={() => {}}
			/>,
		);
		for (const unit of ["lines", "clusters", "files"] as const) {
			rerender(
				<FileTree
					files={files}
					unit={unit}
					current={null}
					onSelect={() => {}}
				/>,
			);
			const lines = within(one()).getByRole("img", {
				name: "3 lines added, 1 deleted",
			});
			expect(lines).toHaveTextContent("+3 −1");
			const count = within(one()).getByRole("img", { name: "2 clusters" });
			expect(count).toHaveTextContent("2");
			expect(count).not.toHaveAttribute("title");
			expect(
				within(screen.getByRole("button", { name: /two\.ts/ })).getByRole(
					"img",
					{ name: "1 cluster" },
				),
			).toBeInTheDocument();
			expect(numbers(one())).toBe(progress[unit]);
		}
		expect(numbers(screen.getByRole("button", { name: /two\.ts/ }))).toBe(
			"done",
		);
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
		const entry = screen.getByRole("button", { name: /new\.md/ });
		expect(numbers(entry)).toBe("1 cluster left");
		expect(part(bar(entry), "reviewed")).toBe(0);
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

describe("tooltip paths", () => {
	afterEach(cleanup);

	it("shows file and folder paths in tooltips in monospace", () => {
		render(
			<FileTree
				files={[file(0, "src/a/x.ts", ["unreviewed"]), file(1, "y.ts", [])]}
				unit="lines"
				current={null}
				onSelect={() => {}}
			/>,
		);
		const paths = [
			...document.querySelectorAll('[role="tooltip"] [data-tooltip-path]'),
		].map((el) => [el.textContent, el.tagName, el.className]);
		expect(paths).toEqual([
			["src/a", "CODE", expect.stringContaining("font-mono")],
			["src/a/x.ts", "CODE", expect.stringContaining("font-mono")],
			["y.ts", "CODE", expect.stringContaining("font-mono")],
		]);
	});
});
