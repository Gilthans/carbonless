// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import type { FileStatus, FileView } from "../../shared/types";
import { ChangeKindIcon, changeKindLabel } from "./changeKind";
import { FileTree } from "./FileTree";

afterEach(cleanup);

/** Open tooltips (decorative ones are found by the DOM, not by role). */
const shown = () =>
	[...document.querySelectorAll('[role="tooltip"]')].filter(
		(t) => !t.hasAttribute("hidden"),
	);

const file = (status: FileStatus, over: Partial<FileView> = {}): FileView => ({
	index: 0,
	path: "src/a.ts",
	status,
	binary: false,
	submodule: false,
	additions: 1,
	deletions: 1,
	clusters: [],
	done: false,
	reviewed: false,
	crossedOff: false,
	...over,
});

describe("changeKindLabel", () => {
	it("names each kind of change", () => {
		expect(changeKindLabel(file("added"))).toBe("Added");
		expect(changeKindLabel(file("deleted"))).toBe("Deleted");
		expect(changeKindLabel(file("modified"))).toBe("Modified");
		expect(changeKindLabel(file("renamed", { oldPath: "src/old.ts" }))).toBe(
			"Renamed from src/old.ts",
		);
		expect(changeKindLabel(file("type-changed"))).toBe("Type changed");
	});

	it("says when the mode changed, alone when nothing else did", () => {
		const modes = { oldMode: "100644", newMode: "100755" };
		expect(
			changeKindLabel(
				file("modified", { ...modes, additions: 0, deletions: 0 }),
			),
		).toBe("Mode changed: 100644 → 100755");
		expect(changeKindLabel(file("modified", modes))).toBe(
			"Modified, mode 100644 → 100755",
		);
		// Same mode on both sides: no mention.
		expect(
			changeKindLabel(
				file("modified", { oldMode: "100644", newMode: "100644" }),
			),
		).toBe("Modified");
		// An added file has only a new mode.
		expect(changeKindLabel(file("added", { newMode: "100644" }))).toBe("Added");
	});
});

describe("ChangeKindIcon", () => {
	it("draws a distinct shape and color per kind, named for assistive tech", () => {
		const kinds: [FileStatus, string, string][] = [
			["added", "Added", "text-ok"],
			["deleted", "Deleted", "text-bad"],
			["modified", "Modified", "text-warn"],
			["renamed", "Renamed from src/old.ts", "text-muted"],
			["type-changed", "Type changed", "text-muted"],
		];
		const shapes = new Set<string>();
		for (const [status, name, color] of kinds) {
			render(<ChangeKindIcon file={file(status, { oldPath: "src/old.ts" })} />);
			const icon = screen.getByRole("img", { name });
			expect(icon).toHaveClass(color);
			shapes.add(icon.querySelector("svg path")?.getAttribute("d") ?? "");
			cleanup();
		}
		expect(shapes.size).toBe(kinds.length);
	});

	it("never uses green or red for a modified file", () => {
		render(<ChangeKindIcon file={file("modified")} />);
		const icon = screen.getByRole("img", { name: "Modified" });
		expect(icon.className).not.toMatch(/text-(ok|bad)\b/);
	});

	it("shows its name in a tooltip on hover", async () => {
		render(<ChangeKindIcon file={file("deleted")} tooltip />);
		await userEvent.hover(screen.getByRole("img", { name: "Deleted" }));
		await waitFor(() => expect(shown()).toHaveLength(1));
		expect(shown()[0]).toHaveTextContent("Deleted");
	});
});

describe("the file tree", () => {
	it("marks each file with its kind of change", async () => {
		render(
			<FileTree
				files={[
					file("added", { index: 0, path: "a/new.ts" }),
					file("deleted", { index: 1, path: "a/gone.ts" }),
					file("modified", { index: 2, path: "a/edit.ts" }),
					file("renamed", {
						index: 3,
						path: "a/moved.ts",
						oldPath: "b/moved.ts",
					}),
				]}
				unit="lines"
				current={null}
				onSelect={() => {}}
			/>,
		);
		// The file's own row, not a rename's old-path entry.
		const kind = (name: RegExp) =>
			screen
				.getAllByRole("button", { name })
				.find((b) => !b.hasAttribute("data-moved"))
				?.querySelector('[data-testid="change-kind"]')
				?.getAttribute("aria-label");
		expect(kind(/new\.ts/)).toBe("Added");
		expect(kind(/gone\.ts/)).toBe("Deleted");
		expect(kind(/edit\.ts/)).toBe("Modified");
		expect(kind(/moved\.ts/)).toBe("Renamed from b/moved.ts");
		// The row's tooltip says it too (touch and keyboard).
		await userEvent.hover(screen.getByRole("button", { name: /gone\.ts/ }));
		await waitFor(() => expect(shown()).toHaveLength(1));
		const tip = shown()[0] as HTMLElement;
		expect(tip.querySelector("[data-tooltip-title]")).toHaveTextContent(
			"gone.ts",
		);
		expect(tip).toHaveTextContent("a/gone.ts");
		expect(
			tip.querySelector('[data-tooltip-line="change-kind"]'),
		).toHaveTextContent(/^Deleted$/);
	});
});
