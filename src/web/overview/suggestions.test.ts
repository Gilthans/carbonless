// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { suggestionHtml } from "../../../test/fake-gh/scenario";
import { splitSuggestions, suggestionBlocks } from "./suggestions";

describe("suggestionBlocks", () => {
	it("reads each suggestion's lines exactly, CRLF bodies included", () => {
		expect(
			suggestionBlocks(
				"Try:\r\n\r\n```suggestion\r\n\tconst a = 1;  \r\n\r\nreturn a;\r\n```\r\nand\n~~~suggestion\nb\n~~~\n",
			),
		).toEqual([["\tconst a = 1;  ", "", "return a;"], ["b"]]);
	});

	it("reads an empty suggestion (delete the lines) as no lines", () => {
		expect(suggestionBlocks("```suggestion\n```")).toEqual([[]]);
	});

	it("skips other fenced blocks, suggestion fences inside them too", () => {
		const body = [
			"````markdown",
			"```suggestion",
			"not one",
			"```",
			"````",
			"```ts",
			"x",
			"```",
			"````suggestion",
			"```js",
			"inner fence kept",
			"```",
			"````",
		].join("\n");
		expect(suggestionBlocks(body)).toEqual([
			["```js", "inner fence kept", "```"],
		]);
	});

	it("strips the fence's own indentation, and gives up on a block left open", () => {
		expect(suggestionBlocks("  ```suggestion\n    a\n  b\n  ```")).toEqual([
			["  a", "b"],
		]);
		expect(suggestionBlocks("```suggestion\na")).toBeNull();
		expect(suggestionBlocks("no fences")).toEqual([]);
	});
});

describe("splitSuggestions", () => {
	const html = (...parts: string[]) => parts.join("\n");

	it("splits GitHub's HTML around each block, with the markdown's lines", () => {
		const parts = splitSuggestions(
			html(
				'<p dir="auto">First:</p>',
				suggestionHtml(["old a"], ["new a"]),
				'<p dir="auto">Then:</p>',
				suggestionHtml(["old a"], []),
			),
			"First:\n```suggestion\nnew a\n```\nThen:\n```suggestion\n```",
		);
		expect(parts).toEqual([
			{ kind: "html", html: '<p dir="auto">First:</p>' },
			{ kind: "suggestion", added: ["new a"], removed: ["old a"] },
			{ kind: "html", html: '<p dir="auto">Then:</p>' },
			{ kind: "suggestion", added: [], removed: ["old a"] },
		]);
	});

	it("takes the text from the markdown, exactly, once GitHub's rows agree", () => {
		const parts = splitSuggestions(
			suggestionHtml(["x"], ["a \u00a0b\t"]),
			"```suggestion\r\na \u00a0b\t\r\n```",
		);
		expect(parts).toEqual([
			{ kind: "suggestion", added: ["a \u00a0b\t"], removed: ["x"] },
		]);
	});

	it("falls back when GitHub's added rows say something else", () => {
		expect(
			splitSuggestions(
				suggestionHtml(["x"], ["a  b"]),
				"```suggestion\na b\n```",
			),
		).toBeNull();
	});

	it("fails closed: no blocks, a count mismatch, a nested block, a short block", () => {
		expect(splitSuggestions("<p>plain</p>", "plain")).toBeNull();
		// The HTML has a block the markdown doesn't (e.g. inside another fence).
		expect(
			splitSuggestions(
				suggestionHtml(["a"], ["b"]),
				"````\n```suggestion\nb\n```\n````",
			),
		).toBeNull();
		expect(
			splitSuggestions(
				`<blockquote>${suggestionHtml(["a"], ["b"])}</blockquote>`,
				"> ```suggestion\n> b\n> ```",
			),
		).toBeNull();
		expect(
			splitSuggestions(
				suggestionHtml(["a"], ["b", "c"]),
				"```suggestion\nb\n```",
			),
		).toBeNull();
	});
});
