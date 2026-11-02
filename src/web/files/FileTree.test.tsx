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

	it("nests files under folders, folders first, by name, with their status", () => {
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
			.filter((b) => !b.hasAttribute("aria-expanded"))
			.map((b) => b.textContent);
		expect(items.map((t) => t?.match(/one|two|b\.ts|api/)?.[0])).toEqual([
			"api",
			"one",
			"two",
			"b.ts",
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
		// Past Fold all and Open all, then folders first, by name: gen, its
		// api.g.cs, src and a/deep.
		for (let i = 0; i < 7; i++) await user.tab();
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

describe("folders", () => {
	afterEach(() => {
		cleanup();
		localStorage.clear();
		vi.restoreAllMocks();
	});

	const folder = (path: string) =>
		document.querySelector<HTMLElement>(
			`[data-folder="${path}"]`,
		) as HTMLElement;
	const fileRow = (name: RegExp) => screen.queryByRole("button", { name });

	it("shows each folder's accumulated progress in a file row's columns", () => {
		render(
			<FileTree
				files={files}
				unit="clusters"
				current={null}
				onSelect={() => {}}
			/>,
		);
		const src = folder("src");
		expect(src.tagName).toBe("BUTTON");
		// The whole group (row and children) in a border; nested groups nest.
		const group = src.closest("li");
		expect(group?.className).toContain("border-line");
		expect(group?.contains(folder("src/a/deep"))).toBe(true);
		expect(folder("src/a/deep").closest("li")?.className).toContain(
			"border-line",
		);
		expect(group?.contains(screen.getByRole("button", { name: /b\.ts/ }))).toBe(
			true,
		);
		// The row itself is tinted, unlike a file's.
		expect(src.className).toContain("bg-band");
		expect(
			screen.getByRole("button", { name: /b\.ts/ }).className,
		).not.toContain("bg-band");
		expect(src).toHaveAttribute("aria-expanded", "true");
		expect(numbers(src)).toBe("2 / 4 clusters · 2 files left");
		expect(src).toHaveAccessibleName(/^src.*2 \/ 4 clusters · 2 files left$/);
		expect(
			within(src).getByRole("img", { name: "9 lines added, 3 deleted" }),
		).toBeInTheDocument();
		expect(
			within(src).getByRole("img", { name: "4 clusters" }),
		).toBeInTheDocument();
		expect(part(bar(src), "reviewed")).toBe(50);
		expect(src).not.toHaveAttribute("data-finished");
		expect(numbers(folder("src/a/deep"))).toBe("2 / 3 clusters · 1 file left");
		// All crossed off: finished, styled like a finished file.
		const gen = folder("gen");
		expect(numbers(gen)).toBe("crossed off");
		expect(gen).toHaveAttribute("data-finished");
		expect(gen.className).toContain("bg-ok/8");
		expect(part(bar(gen), "crossed-off")).toBe(100);
	});

	it("follows the unit", () => {
		const { rerender } = render(
			<FileTree
				files={files}
				unit="lines"
				current={null}
				onSelect={() => {}}
			/>,
		);
		expect(numbers(folder("src"))).toBe("4 / 8 lines · 2 files left");
		rerender(
			<FileTree
				files={files}
				unit="files"
				current={null}
				onSelect={() => {}}
			/>,
		);
		expect(numbers(folder("src"))).toBe("1 / 3 files");
	});

	it("folds and unfolds by click, Enter and Space; folding changes no numbers", async () => {
		const user = userEvent.setup();
		const onSelect = vi.fn();
		render(
			<FileTree
				files={files}
				unit="clusters"
				current={null}
				onSelect={onSelect}
			/>,
		);
		const src = folder("src");
		const before = numbers(src);
		const width = part(bar(src), "reviewed");
		await user.click(src);
		expect(src).toHaveAttribute("aria-expanded", "false");
		expect(fileRow(/one\.ts/)).toBeNull();
		expect(fileRow(/b\.ts/)).toBeNull();
		expect(folder("src/a/deep")).toBeNull();
		// Others stay.
		expect(fileRow(/api\.g\.cs/)).not.toBeNull();
		expect(numbers(src)).toBe(before);
		expect(part(bar(src), "reviewed")).toBe(width);
		expect(src).not.toHaveAttribute("data-finished");
		await user.keyboard("{Enter}");
		expect(src).toHaveAttribute("aria-expanded", "true");
		expect(fileRow(/one\.ts/)).not.toBeNull();
		await user.keyboard(" ");
		expect(src).toHaveAttribute("aria-expanded", "false");
		expect(onSelect).not.toHaveBeenCalled();
	});

	it("never shows a folded folder finished while anything in it is left", async () => {
		const renamed = file(5, "docs/new.md", ["unreviewed"]);
		renamed.clusters = renamed.clusters.map((c) => ({
			...c,
			kind: "file" as const,
			lines: 0,
		}));
		const docs = [file(4, "docs/a.md", ["reviewed"]), renamed];
		render(
			<FileTree files={docs} unit="lines" current={null} onSelect={() => {}} />,
		);
		const row = folder("docs");
		await userEvent.click(row);
		expect(row).toHaveAttribute("aria-expanded", "false");
		// Every line is reviewed, but the rename is left.
		expect(numbers(row)).toBe("2 / 2 lines · 1 file left");
		expect(part(bar(row), "reviewed")).toBeLessThan(100);
		expect(row).not.toHaveAttribute("data-finished");
		expect(row.className).not.toContain("bg-ok");
	});

	it("unfolds a folded folder only when a file inside it is opened, never on scrolling", async () => {
		const user = userEvent.setup();
		const tree = (
			current: number | null,
			opened: number | null,
			seq: number,
		) => (
			<FileTree
				files={files}
				unit="clusters"
				current={current}
				opened={opened}
				onSelect={() => {}}
				revealSeq={seq}
			/>
		);
		const { rerender } = render(tree(2, null, 0));
		await user.click(folder("src"));
		await user.click(folder("src/a/deep"));
		await user.click(folder("src"));
		expect(folder("src")).toHaveAttribute("aria-expanded", "false");
		// Scrolling through files inside it: it stays folded.
		rerender(tree(0, null, 0));
		rerender(tree(1, null, 0));
		rerender(tree(3, null, 0));
		rerender(tree(0, null, 0));
		expect(folder("src")).toHaveAttribute("aria-expanded", "false");
		// Opening a file deep inside it (a pick, a link, its header): every
		// folded ancestor unfolds, whichever file is in view.
		rerender(tree(3, 0, 1));
		expect(folder("src")).toHaveAttribute("aria-expanded", "true");
		expect(folder("src/a/deep")).toHaveAttribute("aria-expanded", "true");
		expect(fileRow(/one\.ts/)).not.toBeNull();
	});

	it("dots the opened file and the one in view, on their rows and folders; opened wins", async () => {
		const tree = (current: number | null, opened: number | null) => (
			<FileTree
				files={files}
				unit="clusters"
				current={current}
				opened={opened}
				onSelect={() => {}}
			/>
		);
		const { rerender } = render(tree(0, null));
		const dot = (row: HTMLElement) =>
			row
				.querySelector('[data-testid="tree-dot"]')
				?.getAttribute("data-mark") ?? null;
		const one = () => fileRow(/one\.ts/) as HTMLElement;
		for (const path of ["src", "src/a/deep"]) {
			expect(dot(folder(path)), path).toBe("in view");
			expect(folder(path)).toHaveAccessibleName(/holds the file in view$/);
			expect(folder(path)).not.toHaveAttribute("aria-current");
		}
		expect(dot(one())).toBe("in view");
		expect(one()).toHaveAccessibleName(/in view/);
		expect(dot(folder("gen"))).toBeNull();
		// Opened api.g.cs, scrolled to one.ts: each its own dot.
		rerender(tree(0, 3));
		expect(dot(folder("gen"))).toBe("opened");
		expect(folder("gen")).toHaveAccessibleName(
			/crossed off, holds the opened file$/,
		);
		expect(dot(fileRow(/api\.g\.cs/) as HTMLElement)).toBe("opened");
		expect(dot(folder("src"))).toBe("in view");
		// Opened two.ts while one.ts is in view: the shared folders show
		// only the opened dot.
		rerender(tree(0, 1));
		expect(dot(folder("src"))).toBe("opened");
		expect(dot(folder("src/a/deep"))).toBe("opened");
		expect(folder("src")).not.toHaveAccessibleName(/in view/);
		expect(dot(one())).toBe("in view");
		expect(dot(fileRow(/two\.ts/) as HTMLElement)).toBe("opened");
		// The opened file is in view too: one dot, opened.
		rerender(tree(1, 1));
		expect(dot(fileRow(/two\.ts/) as HTMLElement)).toBe("opened");
		expect(document.querySelectorAll('[data-mark="in view"]')).toHaveLength(0);
		// Folded, the folder keeps its dot.
		await userEvent.click(folder("src"));
		expect(dot(folder("src"))).toBe("opened");
		expect(document.querySelectorAll('[aria-current="true"]')).toHaveLength(0);
		rerender(tree(null, null));
		expect(document.querySelectorAll('[data-testid="tree-dot"]')).toHaveLength(
			0,
		);
	});

	it("caps a folder's crossed-off share like a file's", () => {
		render(
			<FileTree
				files={[
					file(0, "d/a.ts", ["crossed-off", "crossed-off"]),
					file(1, "d/b.ts", ["unreviewed", "unreviewed"]),
				]}
				unit="clusters"
				current={null}
				onSelect={() => {}}
			/>,
		);
		expect(part(bar(folder("d")), "crossed-off")).toBe(20);
		expect(part(bar(folder("d")), "reviewed")).toBe(0);
	});

	it("keeps folds per PR in storage and ignores unknown paths", async () => {
		const key = "crb:folds:o/r#1";
		localStorage.setItem(key, JSON.stringify(["gen", "nope", 5]));
		const tree = (k: string) => (
			<FileTree
				files={files}
				unit="clusters"
				current={null}
				onSelect={() => {}}
				foldKey={k}
			/>
		);
		const { unmount } = render(tree(key));
		expect(folder("gen")).toHaveAttribute("aria-expanded", "false");
		expect(folder("src")).toHaveAttribute("aria-expanded", "true");
		await userEvent.click(folder("src"));
		expect(JSON.parse(localStorage.getItem(key) ?? "")).toEqual(
			expect.arrayContaining(["gen", "src"]),
		);
		unmount();
		render(tree(key));
		expect(folder("src")).toHaveAttribute("aria-expanded", "false");
		cleanup();
		// Another PR has its own.
		render(tree("crb:folds:o/r#2"));
		expect(folder("src")).toHaveAttribute("aria-expanded", "true");
	});

	it("folds in memory when storage throws", async () => {
		vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
			throw new Error("blocked");
		});
		vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
			throw new Error("blocked");
		});
		render(
			<FileTree
				files={files}
				unit="clusters"
				current={null}
				onSelect={() => {}}
				foldKey="crb:folds:o/r#1"
			/>,
		);
		expect(folder("src")).toHaveAttribute("aria-expanded", "true");
		await userEvent.click(folder("src"));
		expect(folder("src")).toHaveAttribute("aria-expanded", "false");
		expect(fileRow(/one\.ts/)).toBeNull();
	});
	it("keeps a stored fold over the current file on load, remount and scrolling", () => {
		const key = "crb:folds:o/r#3";
		localStorage.setItem(key, JSON.stringify(["src"]));
		const tree = (
			current: number | null,
			revealSeq = 0,
			opened: number | null = null,
		) => (
			<FileTree
				files={files}
				unit="clusters"
				current={current}
				opened={opened}
				onSelect={() => {}}
				foldKey={key}
				revealSeq={revealSeq}
			/>
		);
		// Mounted with the opened file inside it (a remount: the sheet), after
		// earlier picks (revealSeq already above 0).
		const { unmount } = render(tree(0, 3, 0));
		expect(folder("src")).toHaveAttribute("aria-expanded", "false");
		expect(folder("src")).toHaveAttribute("data-holds-opened");
		unmount();
		// A reload: nothing current, then the file in view settles, then the
		// reviewer scrolls on.
		const { rerender } = render(tree(null));
		rerender(tree(0));
		rerender(tree(1));
		expect(folder("src")).toHaveAttribute("aria-expanded", "false");
		expect(JSON.parse(localStorage.getItem(key) ?? "")).toEqual(["src"]);
		// Opening a file in it unfolds it.
		rerender(tree(1, 1, 1));
		expect(folder("src")).toHaveAttribute("aria-expanded", "true");
		expect(localStorage.getItem(key)).toBeNull();
	});

	it("writes storage only when the folds change", async () => {
		const set = vi.spyOn(Storage.prototype, "setItem");
		const tree = (current: number | null) => (
			<FileTree
				files={files}
				unit="clusters"
				current={current}
				onSelect={() => {}}
				foldKey="crb:folds:o/r#6"
			/>
		);
		const { rerender } = render(tree(null));
		expect(set).not.toHaveBeenCalled();
		await userEvent.click(folder("gen"));
		expect(set).toHaveBeenCalledTimes(1);
		rerender(tree(0));
		rerender(tree(1));
		rerender(tree(2));
		expect(set).toHaveBeenCalledTimes(1);
	});

	it("doesn't redo an earlier reveal once the PR is known", () => {
		const key = "crb:folds:o/r#7";
		localStorage.setItem(key, JSON.stringify(["src"]));
		const tree = (k: string | null) => (
			<FileTree
				files={files}
				unit="clusters"
				current={0}
				opened={0}
				onSelect={() => {}}
				foldKey={k}
				// A pick made earlier, before this mount.
				revealSeq={2}
			/>
		);
		const { rerender } = render(tree(null));
		rerender(tree(key));
		expect(folder("src")).toHaveAttribute("aria-expanded", "false");
	});

	it("reveals on an explicit navigation, even right after load", () => {
		const key = "crb:folds:o/r#4";
		localStorage.setItem(key, JSON.stringify(["src", "gen"]));
		const tree = (current: number | null, revealSeq: number) => (
			<FileTree
				files={files}
				unit="clusters"
				current={current}
				opened={current}
				onSelect={() => {}}
				foldKey={key}
				revealSeq={revealSeq}
			/>
		);
		const { rerender } = render(tree(null, 0));
		// A link on a cold open: null to a file, with a reveal request.
		rerender(tree(2, 1));
		expect(folder("src")).toHaveAttribute("aria-expanded", "true");
		expect(folder("gen")).toHaveAttribute("aria-expanded", "false");
		expect(JSON.parse(localStorage.getItem(key) ?? "")).toEqual(["gen"]);
	});

	it("keeps folds made before the PR is known, and reveals the linked file once it is", async () => {
		const key = "crb:folds:o/r#5";
		localStorage.setItem(key, JSON.stringify(["src", "gen"]));
		const tree = (
			k: string | null,
			current: number | null,
			opened: number | null,
			seq: number,
		) => (
			<FileTree
				files={files}
				unit="clusters"
				current={current}
				opened={opened}
				onSelect={() => {}}
				foldKey={k}
				revealSeq={seq}
			/>
		);
		const { rerender } = render(tree(null, null, null, 0));
		await userEvent.click(folder("gen"));
		// A link landed before the session: its file is in src.
		rerender(tree(null, 2, 2, 1));
		// The scroll tracker moved on to gen's file before the key arrived:
		// the reveal is still the linked file's.
		rerender(tree(null, 3, 2, 1));
		rerender(tree(key, 3, 2, 1));
		expect(folder("gen")).toHaveAttribute("aria-expanded", "false");
		expect(folder("src")).toHaveAttribute("aria-expanded", "true");
		expect(JSON.parse(localStorage.getItem(key) ?? "")).toEqual(["gen"]);
	});

	it("never draws a folder's meter full while a file without clusters is left", () => {
		const empty: FileView = { ...file(7, "docs/empty.md", []), done: false };
		render(
			<FileTree
				files={[file(6, "docs/a.md", ["reviewed"]), empty]}
				unit="lines"
				current={null}
				onSelect={() => {}}
			/>,
		);
		const row = folder("docs");
		expect(numbers(row)).toBe("2 / 2 lines · 1 file left");
		expect(part(bar(row), "reviewed")).toBeLessThan(100);
		expect(row).not.toHaveAttribute("data-finished");
	});
});

describe("renamed files", () => {
	afterEach(() => {
		cleanup();
		localStorage.clear();
	});

	const folder = (path: string) =>
		document.querySelector<HTMLElement>(
			`[data-folder="${path}"]`,
		) as HTMLElement;
	const moved = (old: string) =>
		document.querySelector<HTMLElement>(`[data-moved="${old}"]`) as HTMLElement;
	const renamed = (index: number, path: string, oldPath: string): FileView => ({
		...file(index, path, ["unreviewed"]),
		status: "renamed",
		oldPath,
	});
	// Moved to another folder, renamed in place, and a plain file.
	const tree = [
		renamed(0, "new/x.ts", "old/x.ts"),
		renamed(1, "lib/b.ts", "lib/a.ts"),
		file(2, "lib/c.ts", ["reviewed"]),
	];

	it("shows the old path as a faded entry that opens the same file", async () => {
		const onSelect = vi.fn();
		render(
			<FileTree
				files={tree}
				unit="clusters"
				current={null}
				onSelect={onSelect}
			/>,
		);
		for (const [old, index] of [
			["old/x.ts", 0],
			["lib/a.ts", 1],
		] as const) {
			const entry = moved(old);
			expect(entry, old).not.toBeNull();
			expect(entry.className).toContain("opacity-60");
			// Reversed rename icon in red; no counts, meter or status.
			const icon = entry.querySelector("svg");
			expect(icon?.getAttribute("class")).toContain("text-bad");
			expect(icon?.getAttribute("class")).toContain("-scale-x-100");
			expect(entry.querySelector('[data-testid="tree-meter"]')).toBeNull();
			expect(entry.querySelector('[data-testid="change-count"]')).toBeNull();
			expect(within(entry).queryByRole("img")).toBeNull();
			await userEvent.click(entry);
			expect(onSelect).toHaveBeenLastCalledWith(index);
		}
		expect(moved("old/x.ts")).toHaveAccessibleName("x.ts, moved away");
		// The new path's rename icon is green.
		const now = screen
			.getAllByRole("button", { name: /x\.ts/ })
			.find((b) => !b.hasAttribute("data-moved")) as HTMLElement;
		expect(
			now.querySelector('[data-testid="change-kind"]')?.getAttribute("class"),
		).toContain("text-ok");
		// Its tooltip says where it went.
		const tips = [...document.querySelectorAll('[role="tooltip"]')].map(
			(t) => t.textContent,
		);
		expect(tips).toContain("old/x.ts → new/x.ts");
	});

	it("counts each file once, at its new path; a folder of old paths is a ghost", () => {
		render(
			<FileTree
				files={tree}
				unit="clusters"
				current={0}
				opened={1}
				onSelect={() => {}}
			/>,
		);
		const ghost = folder("old");
		expect(ghost).toHaveAttribute("data-ghost");
		expect(ghost.className).toContain("opacity-60");
		expect(ghost.querySelector('[data-testid="tree-meter"]')).toBeNull();
		expect(ghost.querySelector('[data-testid="tree-numbers"]')).toBeNull();
		expect(ghost.querySelector('[data-testid="change-count"]')).toBeNull();
		expect(ghost).toHaveAttribute("aria-expanded", "true");
		// Old paths never get dots, nor do their ghost folders.
		expect(ghost.querySelector('[data-testid="tree-dot"]')).toBeNull();
		expect(
			moved("old/x.ts").querySelector('[data-testid="tree-dot"]'),
		).toBeNull();
		expect(
			moved("lib/a.ts").querySelector('[data-testid="tree-dot"]'),
		).toBeNull();
		// A folder with real files and old paths: numbers from the real ones.
		expect(
			folder("lib").querySelector('[data-testid="tree-numbers"]')?.textContent,
		).toBe("1 / 2 clusters · 1 file left");
		expect(
			folder("new").querySelector('[data-testid="tree-numbers"]')?.textContent,
		).toBe("0 / 1 cluster · 1 file left");
		expect(
			folder("lib")
				.querySelector('[data-testid="tree-dot"]')
				?.getAttribute("data-mark"),
		).toBe("opened");
		expect(
			folder("new")
				.querySelector('[data-testid="tree-dot"]')
				?.getAttribute("data-mark"),
		).toBe("in view");
		// Ghosts fold like any folder.
		return userEvent.click(ghost).then(() => {
			expect(ghost).toHaveAttribute("aria-expanded", "false");
			expect(moved("old/x.ts")).toBeNull();
		});
	});

	it("folds every folder with Fold all, ghosts too, and opens them with Open all", async () => {
		const key = "crb:folds:o/r#9";
		const user = userEvent.setup();
		const { unmount } = render(
			<FileTree
				files={tree}
				unit="clusters"
				current={0}
				onSelect={() => {}}
				foldKey={key}
			/>,
		);
		await user.click(screen.getByRole("button", { name: "Fold all" }));
		for (const path of ["lib", "new", "old"]) {
			expect(folder(path), path).toHaveAttribute("aria-expanded", "false");
		}
		// The file in view stays hidden: only opening a file reveals it.
		expect(screen.queryByRole("button", { name: /c\.ts/ })).toBeNull();
		expect(JSON.parse(localStorage.getItem(key) ?? "").sort()).toEqual([
			"lib",
			"new",
			"old",
		]);
		unmount();
		render(
			<FileTree
				files={tree}
				unit="clusters"
				current={0}
				onSelect={() => {}}
				foldKey={key}
			/>,
		);
		expect(folder("new")).toHaveAttribute("aria-expanded", "false");
		await user.click(screen.getByRole("button", { name: "Open all" }));
		for (const path of ["lib", "new", "old"]) {
			expect(folder(path), path).toHaveAttribute("aria-expanded", "true");
		}
		expect(localStorage.getItem(key)).toBeNull();
	});
});
