import { describe, expect, it } from "vitest";
import { reviewThread, threadComment } from "../../test/fake-gh/scenario";
import {
	markerFor,
	markerText,
	parseMarker,
	spanCols,
	stripMarker,
	stripMarkerHtml,
} from "./marker";
import { mapComments, mapThreads } from "./overview";

const span = { startLine: 3, startCol: 9, line: 5, endCol: 24 };

describe("the marker", () => {
	it("is written, parsed and stripped: a round trip", () => {
		const body = `Rename this?${markerFor("c-1", span)}`;
		expect(body).toBe("Rename this?\n\n<!-- crb:v1 id=c-1 span=3:9-5:24 -->");
		expect(parseMarker(body)).toEqual({ id: "c-1", span });
		expect(stripMarker(body)).toBe("Rename this?");
		expect(markerText(body)).toBe("\n\n<!-- crb:v1 id=c-1 span=3:9-5:24 -->");
		expect(stripMarker(body) + markerText(body)).toBe(body);
		const plain = `Hm${markerFor("c-2")}`;
		expect(parseMarker(plain)).toEqual({ id: "c-2", span: null });
		expect(stripMarker(plain)).toBe("Hm");
	});

	it("only a trailing one counts; trailing whitespace and CRLF aside", () => {
		expect(parseMarker("<!-- crb:v1 id=a --> and then text")).toBeNull();
		expect(stripMarker("<!-- crb:v1 id=a --> and then text")).toBe(
			"<!-- crb:v1 id=a --> and then text",
		);
		expect(stripMarker("Ok\r\n\r\n<!-- crb:v1 id=a -->\r\n ")).toBe("Ok");
		// The last comment only, the one before stays text.
		expect(
			stripMarker("A <!-- crb:v1 id=x --> B\n\n<!-- crb:v1 id=y -->"),
		).toBe("A <!-- crb:v1 id=x --> B");
		expect(parseMarker("a\n<!-- crb:v1 id=x --> b -->")).toBeNull();
	});

	it("a hand-edited one is stripped while it reads as crb's, left as text otherwise; never throws", () => {
		for (const garbage of [
			"Hi <!-- crb:v1 id=a span=oops -->",
			"Hi <!-- crb:v1 span=1:2-3 -->",
			"Hi <!--crb:v7 whatever-->",
			"Hi <!-- crb: -->",
			"Hi <!-- crb:v1 id=has%space span=0:1-2:3 -->",
		]) {
			expect(stripMarker(garbage)).toBe("Hi");
			const parsed = parseMarker(garbage);
			expect(parsed?.span).toBeNull();
		}
		expect(parseMarker("Hi <!-- crb:v1 id=a span=oops -->")?.id).toBe("a");
		for (const text of [
			"Hi <!-- a note -->",
			"Hi <!-- crb v1 -->",
			"Hi -->",
			"<!--",
			"",
			"-->",
		]) {
			expect(stripMarker(text)).toBe(text);
			expect(parseMarker(text)).toBeNull();
		}
		expect(stripMarker(" ".repeat(100_000))).toBe(" ".repeat(100_000));
	});

	it("an id that could break the comment is never written", () => {
		expect(() => markerFor("a -->")).toThrow();
		expect(() => markerFor("")).toThrow();
	});

	it("gives columns only on the lines it was made on", () => {
		const m = parseMarker(`x${markerFor("c", span)}`);
		expect(spanCols(m, { startLine: 3, line: 5 })).toEqual({
			startCol: 9,
			endCol: 24,
		});
		expect(spanCols(m, { startLine: 3, line: 6 })).toBeNull();
		expect(spanCols(m, { startLine: 2, line: 5 })).toBeNull();
		expect(
			spanCols(parseMarker(`x${markerFor("c")}`), { startLine: 3, line: 5 }),
		).toBeNull();
		expect(spanCols(null, { startLine: 3, line: 5 })).toBeNull();
	});

	it("strips one GitHub's HTML might keep", () => {
		expect(stripMarkerHtml('<p dir="auto">Hi</p>\n<!-- crb:v1 id=a -->')).toBe(
			'<p dir="auto">Hi</p>',
		);
		expect(stripMarkerHtml("<p>Hi &lt;!-- crb:v1 id=a --&gt;")).toBe("<p>Hi");
		expect(stripMarkerHtml("<p>Hi</p>")).toBe("<p>Hi</p>");
	});
});

describe("reads strip the marker and take the span from it", () => {
	const marked = (body: string) =>
		threadComment({
			login: "Octo_Cat",
			text: stripMarker(body),
			body,
			commit: "a".repeat(40),
		});
	const read = (
		lines: { line: number; originalStartLine: number | null },
		body: string,
	) => {
		const node = reviewThread(
			{ path: "a.txt", ...lines, startLine: lines.originalStartLine },
			[marked(body), threadComment({ login: "rev", text: "Sure" })],
		);
		const withIds = {
			...node,
			id: "T1",
			comments: {
				...node.comments,
				nodes: node.comments.nodes.map((c, i) => ({ ...c, id: `C${i}` })),
			},
		};
		const [thread] = mapThreads([withIds], {
			prAuthor: "rev",
			viewer: "Octo_Cat",
		});
		const { comments } = mapComments(withIds, withIds, undefined, true);
		return { thread, comments };
	};

	it("the opener's columns when its lines are the thread's; its body without the marker everywhere", () => {
		const { thread, comments } = read(
			{ line: 5, originalStartLine: 3 },
			`Look${markerFor("c", span)}`,
		);
		expect(thread?.anchor).toMatchObject({
			startLine: 3,
			line: 5,
			startCol: 9,
			endCol: 24,
		});
		expect(thread?.code?.anchor).toMatchObject({ startCol: 9, endCol: 24 });
		expect(thread).toMatchObject({ body: "Look", excerpt: "Look" });
		expect(comments.map((c) => c.body)).toEqual(["Look", "Sure"]);
		expect(comments[0]?.text).toBe("Look");
	});

	it("lines that don't match the marker's (moved, or hand-edited): whole lines", () => {
		const { thread } = read(
			{ line: 6, originalStartLine: 3 },
			`Look${markerFor("c", span)}`,
		);
		expect(thread?.anchor?.startCol ?? null).toBeNull();
		expect(thread?.anchor?.endCol ?? null).toBeNull();
		expect(thread?.body).toBe("Look");
	});

	it("a thread made on GitHub has no columns", () => {
		const { thread } = read({ line: 5, originalStartLine: 3 }, "Plain");
		expect(thread?.anchor).not.toHaveProperty("startCol");
		expect(thread?.body).toBe("Plain");
	});

	it("an opener blanked to [deleted] with its marker still reads as deleted", () => {
		const { comments } = read(
			{ line: 5, originalStartLine: 3 },
			`[deleted]${markerFor("c", span)}`,
		);
		expect(comments[0]).toMatchObject({ deleted: true, body: "[deleted]" });
	});
});
