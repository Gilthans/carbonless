// @vitest-environment jsdom
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	CommentPreview,
	commentHtml,
	isPreviewKey,
	PreviewToggle,
	useWritePreview,
	type WriteMode,
} from "./CommentPreview";
import { ImageErrorContext } from "./GithubHtml";

afterEach(cleanup);

describe("CommentPreview", () => {
	it("renders markdown as a posted comment: a heading, a list, code, a table, a link", () => {
		render(
			<CommentPreview
				text={[
					"## Why",
					"",
					"- one",
					"- two",
					"",
					"Use `retry()` here:",
					"",
					"```ts",
					"const x = 1;",
					"```",
					"",
					"| a | b |",
					"|---|---|",
					"| 1 | 2 |",
					"",
					"[docs](https://example.com/docs)",
				].join("\n")}
			/>,
		);
		const preview = screen.getByTestId("comment-preview");
		expect(
			screen.getByRole("heading", { level: 2, name: "Why" }),
		).toBeInTheDocument();
		expect(screen.getAllByRole("listitem")).toHaveLength(2);
		expect(preview.querySelector("code")).toHaveTextContent("retry()");
		expect(preview.querySelector("pre")).toHaveTextContent("const x = 1;");
		expect(screen.getByRole("table")).toBeInTheDocument();
		const link = screen.getByRole("link", { name: "docs" });
		expect(link).toHaveAttribute("href", "https://example.com/docs");
		expect(link).toHaveAttribute("target", "_blank");
	});

	it("shows a tag GitHub would drop as text, as it will post (escapeTags)", () => {
		render(<CommentPreview text="A List<String> here" />);
		expect(screen.getByTestId("comment-preview")).toHaveTextContent(
			"A List<String> here",
		);
	});

	it("strips scripts, handlers and javascript: links", () => {
		const evil = [
			'<img src=x onerror="alert(1)">',
			"<script>alert(2)</script>",
			"[x](javascript:alert(3))",
			"![y](javascript:alert(4))",
			'<a href="javascript:alert(5)">z</a>',
		].join("\n\n");
		render(<CommentPreview text={evil} />);
		const preview = screen.getByTestId("comment-preview");
		expect(preview.querySelector("script")).toBeNull();
		expect(preview.innerHTML).not.toMatch(/onerror/i);
		expect(preview.innerHTML).not.toMatch(/javascript:/i);
		for (const el of preview.querySelectorAll("*")) {
			for (const attr of el.attributes) {
				expect(attr.name.startsWith("on")).toBe(false);
			}
		}
	});

	it("a broken image in a preview never asks the page to refresh its images", () => {
		const refresh = vi.fn();
		render(
			<ImageErrorContext value={refresh}>
				<CommentPreview text="![x](https://example.com/typo.png)" />
			</ImageErrorContext>,
		);
		const img = screen.getByTestId("comment-preview").querySelector("img");
		if (!img) throw new Error("no image");
		fireEvent.error(img);
		expect(refresh).not.toHaveBeenCalled();
	});

	it("the unsanitized HTML would carry the javascript: link (the sanitizer is what strips it)", () => {
		// Guards the test above: marked alone keeps it.
		expect(commentHtml("[x](javascript:alert(3))")).toMatch(/javascript:/);
	});
});

describe("isPreviewKey", () => {
	const key = (more: Partial<KeyboardEventInit>) =>
		new KeyboardEvent("keydown", { key: "P", code: "KeyP", ...more });
	it("is Ctrl/Cmd+Shift+P only", () => {
		expect(isPreviewKey(key({ ctrlKey: true, shiftKey: true }))).toBe(true);
		expect(isPreviewKey(key({ metaKey: true, shiftKey: true }))).toBe(true);
		expect(isPreviewKey(key({ ctrlKey: true, shiftKey: true, key: "p" }))).toBe(
			true,
		);
		expect(isPreviewKey(key({ ctrlKey: true }))).toBe(false);
		// By the letter printed, not the physical key (Dvorak's KeyP is "l").
		expect(
			isPreviewKey(
				key({ ctrlKey: true, shiftKey: true, key: "L", code: "KeyP" }),
			),
		).toBe(false);
		expect(
			isPreviewKey(
				key({ ctrlKey: true, shiftKey: true, key: "P", code: "KeyR" }),
			),
		).toBe(true);
		expect(isPreviewKey(key({ shiftKey: true }))).toBe(false);
		expect(
			isPreviewKey(
				key({ ctrlKey: true, shiftKey: true, key: "O", code: "KeyO" }),
			),
		).toBe(false);
	});
});

function Box(props: { initial: WriteMode; text?: string; off?: boolean }) {
	const [text, setText] = useState(props.text ?? "**hi**");
	const box = useRef<HTMLTextAreaElement>(null);
	const p = useWritePreview({
		initial: props.initial,
		text,
		box,
		off: props.off,
	});
	return (
		<div>
			<button type="button" onClick={() => setText("")}>
				Clear
			</button>
			{p.toggle && <PreviewToggle {...p.toggleProps} />}
			<textarea
				ref={box}
				aria-label="Comment"
				value={text}
				hidden={p.mode === "preview"}
				onKeyDown={p.onKeyDown}
				onChange={(e) => setText(e.target.value)}
			/>
			{p.mode === "preview" && (
				<CommentPreview text={text} {...p.previewProps} />
			)}
		</div>
	);
}

describe("useWritePreview", () => {
	it("opens in its default", () => {
		render(<Box initial="preview" />);
		expect(screen.getByTestId("comment-preview")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Preview" })).toHaveAttribute(
			"aria-pressed",
			"true",
		);
		cleanup();
		render(<Box initial="write" />);
		expect(screen.queryByTestId("comment-preview")).toBeNull();
		expect(screen.getByRole("textbox", { name: "Comment" })).toBeVisible();
	});

	it("toggling keeps the text; Write focuses the box, the cursor where it was", async () => {
		render(<Box initial="write" text="hello world" />);
		const box = screen.getByRole("textbox", {
			name: "Comment",
		}) as HTMLTextAreaElement;
		box.focus();
		box.setSelectionRange(5, 5);
		await userEvent.click(screen.getByRole("button", { name: "Preview" }));
		expect(screen.getByTestId("comment-preview")).toHaveTextContent(
			"hello world",
		);
		await userEvent.click(screen.getByRole("button", { name: "Write" }));
		expect(box).toHaveFocus();
		expect(box).toHaveValue("hello world");
		expect(box.selectionStart).toBe(5);
	});

	it("Ctrl/Cmd+Shift+P switches mode, from the box and from the preview", async () => {
		render(<Box initial="write" />);
		const box = screen.getByRole("textbox", { name: "Comment" });
		box.focus();
		await userEvent.keyboard("{Control>}{Shift>}P{/Shift}{/Control}");
		const preview = screen.getByTestId("comment-preview");
		expect(preview).toHaveFocus();
		await userEvent.keyboard("{Meta>}{Shift>}P{/Shift}{/Meta}");
		expect(screen.queryByTestId("comment-preview")).toBeNull();
		expect(box).toHaveFocus();
	});

	it("an emptied box forgets Preview: the next text is typed in Write", async () => {
		render(<Box initial="write" text="first" />);
		await userEvent.click(screen.getByRole("button", { name: "Preview" }));
		expect(screen.getByTestId("comment-preview")).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Clear" }));
		const box = screen.getByRole("textbox", { name: "Comment" });
		await userEvent.click(box);
		await userEvent.keyboard("next");
		expect(screen.queryByTestId("comment-preview")).toBeNull();
		expect(screen.getByRole("textbox", { name: "Comment" })).toHaveFocus();
		expect(box).toHaveValue("next");
	});

	it("has no toggle on blank text, and stays in Write there", () => {
		render(<Box initial="preview" text="  " />);
		expect(screen.queryByRole("button", { name: "Preview" })).toBeNull();
		expect(screen.queryByTestId("comment-preview")).toBeNull();
	});

	it("has no toggle when off (Ask agent), and stays in Write", () => {
		render(<Box initial="preview" off />);
		expect(screen.queryByRole("button", { name: "Preview" })).toBeNull();
		expect(screen.queryByTestId("comment-preview")).toBeNull();
	});

	it("the preview is at least as tall as the box it replaces", async () => {
		render(<Box initial="write" />);
		const box = screen.getByRole("textbox", { name: "Comment" });
		Object.defineProperty(box, "offsetHeight", { value: 120 });
		await act(async () => {
			await userEvent.click(screen.getByRole("button", { name: "Preview" }));
		});
		expect(screen.getByTestId("comment-preview").style.minHeight).toBe("120px");
	});
});
