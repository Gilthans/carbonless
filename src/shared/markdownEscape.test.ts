import { describe, expect, it } from "vitest";
import { escapeTags, unescapeTags } from "./markdownEscape";

/** [typed, as posted] */
const CASES: [string, string, string][] = [
	["generic", "List<String>", "List\\<String>"],
	["type parameter", "<T>", "\\<T>"],
	[
		"owner's probe",
		"a < b, x<y, List<String>, <T>",
		"a < b, x<y, List\\<String>, \\<T>",
	],
	["closing tag", "Foo</T>", "Foo\\</T>"],
	["attributes", "<T extends Foo>", "\\<T extends Foo>"],
	["self-closing", "<Widget />", "\\<Widget />"],
	["nested generics", "Map<K, List<V>>", "Map<K, List\\<V>>"],
	["comma: not a tag", "Map<K, V>", "Map<K, V>"],
	["less than", "a < b", "a < b"],
	["no space", "x<3 and i<=n", "x<3 and i<=n"],
	["at line start", "<T> first\nthen <U>", "\\<T> first\nthen \\<U>"],
	["alone on a line", "a\n\n<T>\n\nb", "a\n\n\\<T>\n\nb"],
	["already escaped", "List\\<String>", "List\\<String>"],
	["escaped backslash", "a\\\\<T>", "a\\\\\\<T>"],
	["html comment", "x <!-- note --> y", "x <!-- note --> y"],
	[
		"marker",
		"List<T>\n\n<!-- crb:v1 id=abc -->",
		"List\\<T>\n\n<!-- crb:v1 id=abc -->",
	],
	[
		"autolink",
		"<https://x.y/a?b=c> <mailto:a@b.c> <a@b.co>",
		"<https://x.y/a?b=c> <mailto:a@b.c> <a@b.co>",
	],
	[
		"kept tags",
		"<b>bold</b> <kbd>Ctrl</kbd> <details><summary>s</summary>",
		"<b>bold</b> <kbd>Ctrl</kbd> <details><summary>s</summary>",
	],
	["kept, any case", "<KBD>k</KBD> <Sub>2</Sub>", "<KBD>k</KBD> <Sub>2</Sub>"],
	["a with href", '<a href="https://x.y">x</a>', '<a href="https://x.y">x</a>'],
	["bare a dropped", "Option<a>", "Option\\<a>"],
	["one-letter generic", "Supplier<S> and Fn<B>", "Supplier\\<S> and Fn\\<B>"],
	[
		"dropped tags",
		"<abbr>x</abbr> <cite>c</cite>",
		"\\<abbr>x\\</abbr> \\<cite>c\\</cite>",
	],
	["tag filter shows anyway", "<script>x</script>", "<script>x</script>"],
	[
		"declaration and PI",
		'<!DOCTYPE html> <?xml version="1.0"?>',
		'\\<!DOCTYPE html> \\<?xml version="1.0"?>',
	],
	[
		"code span",
		"`List<String>` and List<String>",
		"`List<String>` and List\\<String>",
	],
	["double backticks", "``a ` <T>`` <T>", "``a ` <T>`` \\<T>"],
	["unmatched backtick", "` <T>", "` \\<T>"],
	["escaped backtick", "\\` <T> `", "\\` \\<T> `"],
	["code span over lines", "`a\n<T>` <U>", "`a\n<T>` \\<U>"],
	[
		"fence",
		"```ts\nconst x: List<T> = y;\n```\nList<T>",
		"```ts\nconst x: List<T> = y;\n```\nList\\<T>",
	],
	["tilde fence", "~~~\n<T>\n~~~\n<T>", "~~~\n<T>\n~~~\n\\<T>"],
	[
		"short close stays open",
		"````\n<T>\n```\n<T>\n````\n<T>",
		"````\n<T>\n```\n<T>\n````\n\\<T>",
	],
	[
		"unclosed fence",
		"<T>\n```\n<T>\nList<String>",
		"\\<T>\n```\n<T>\nList<String>",
	],
	[
		"suggestion",
		"```suggestion\nconst a: Array<T> = [];\n```",
		"```suggestion\nconst a: Array<T> = [];\n```",
	],
	[
		"fence in a quote",
		"> ```\n> <T>\n> ```\n> <T>",
		"> ```\n> <T>\n> ```\n> \\<T>",
	],
	[
		"indented code",
		"text\n\n    List<T> x;\n\nList<T>",
		"text\n\n    List<T> x;\n\nList\\<T>",
	],
	["tab code", "\tList<T>", "\tList<T>"],
	["continuation is text", "para\n    List<T>", "para\n    List\\<T>"],
	["link text", "[List<T>](https://x.y)", "[List\\<T>](https://x.y)"],
	["link destination", "[x](<a b>)", "[x](<a b>)"],
	["heading", "## Use List<T>", "## Use List\\<T>"],
	["quote", "> List<T>", "> List\\<T>"],
	["list", "- List<T>\n- Map<K,V>", "- List\\<T>\n- Map<K,V>"],
	[
		"CRLF",
		"a<T>\r\n```\r\n<T>\r\n```\r\n<T>\r\n",
		"a\\<T>\r\n```\r\n<T>\r\n```\r\n\\<T>\r\n",
	],
	[
		"html block",
		"<details>\n<summary>List<T></summary>\n\nList<T>\n</details>",
		"<details>\n<summary>List<T></summary>\n\nList\\<T>\n</details>",
	],
	["empty", "", ""],
];

describe("escapeTags", () => {
	it.each(CASES)("%s", (_, typed, posted) => {
		expect(escapeTags(typed)).toBe(posted);
	});

	it("is idempotent", () => {
		for (const [, typed] of CASES) {
			expect(escapeTags(escapeTags(typed))).toBe(escapeTags(typed));
		}
	});

	it("stays linear on a long body", () => {
		const body = "<a x='".repeat(2000) + "List<T> ".repeat(5000);
		const t = process.threadCpuUsage();
		escapeTags(body);
		expect(process.threadCpuUsage(t).user).toBeLessThan(2_000_000);
	});
});

describe("unescapeTags", () => {
	it.each(CASES)("undoes %s", (_, typed, posted) => {
		// What was typed, unless it was escaped already (that reads unescaped).
		expect(escapeTags(unescapeTags(posted))).toBe(posted);
		if (!typed.includes("\\<")) expect(unescapeTags(posted)).toBe(typed);
	});

	it("leaves escapes it didn't add", () => {
		expect(unescapeTags("a \\< b, \\<b>x</b>, `\\<T>`")).toBe(
			"a \\< b, \\<b>x</b>, `\\<T>`",
		);
	});

	it("round-trips: escape(unescape(escape(x))) === escape(x)", () => {
		const parts = [
			"<T>",
			"</T>",
			"\\",
			"`",
			"``",
			"a",
			" ",
			"\n",
			"<b>",
			"```\n",
			"    ",
			"<!--",
			"-->",
			"<details>",
			">",
			"<",
			"<a>",
			"x<y",
			"\r\n",
			"- ",
		];
		let seed = 7;
		const rand = () => {
			seed = (seed * 1103515245 + 12345) % 2 ** 31;
			return seed / 2 ** 31;
		};
		for (let n = 0; n < 3000; n++) {
			const len = 1 + Math.floor(rand() * 12);
			let x = "";
			for (let k = 0; k < len; k++)
				x += parts[Math.floor(rand() * parts.length)];
			const e = escapeTags(x);
			expect(escapeTags(unescapeTags(e)), JSON.stringify(x)).toBe(e);
		}
	});
});
