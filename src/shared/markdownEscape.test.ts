import { describe, expect, it } from "vitest";
import { bestCpuRatio, repeat } from "../../test/cpu";
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
	// A fence closes only in its own container, indented 0-3 spaces.
	[
		"suggestion with an indented inner fence",
		"```suggestion\n1. Build:\n    ```sh\n    make\n    ```\nUse List<T> here\n```\nList<T>",
		"```suggestion\n1. Build:\n    ```sh\n    make\n    ```\nUse List<T> here\n```\nList\\<T>",
	],
	[
		"closer indented 4",
		"```\n    ```\nList<T>\n```\n<T>",
		"```\n    ```\nList<T>\n```\n\\<T>",
	],
	[
		"quoted closer in a top-level fence",
		"```md\n> ```\nList<T>\n```\n<T>",
		"```md\n> ```\nList<T>\n```\n\\<T>",
	],
	[
		"listed closer in a top-level fence",
		"```md\n- ```\nList<T>\n```\n<T>",
		"```md\n- ```\nList<T>\n```\n\\<T>",
	],
	[
		"list fence closes in its item",
		"- ```\n  List<T>\n  ```\n- <T>",
		"- ```\n  List<T>\n  ```\n- \\<T>",
	],
	[
		"closer indented 3",
		"```\nList<T>\n   ```\n<T>",
		"```\nList<T>\n   ```\n\\<T>",
	],
	// GFM autolinks a bare URL: an escape there would land in the link.
	[
		"bare URL",
		"see https://x.com/List<T> here, <T>",
		"see https://x.com/List<T> here, \\<T>",
	],
	[
		"www link",
		"see www.example.com/a<T> here",
		"see www.example.com/a<T> here",
	],
	["URL in parentheses", "(http://x.y/a<T>)", "(http://x.y/a<T>)"],
	["not a URL", "xhttps://x<T>", "xhttps://x\\<T>"],
	// A bare one-letter closing tag goes with its opening one.
	["one-letter closing", "<B>bold</B> <b>b</b>", "\\<B>bold\\</B> <b>b</b>"],
	// A fence on a list item's later line: its column is its own indent,
	// so a closer further left (which, on GitHub, opens a new fence) keeps it open.
	[
		"list fence after a blank line",
		"- item\n\n  ```\n  code\n```\nList<T>\n```",
		"- item\n\n  ```\n  code\n```\nList<T>\n```",
	],
	[
		"list fence, no blank line",
		"- item\n  ```\n  code\n```\nList<T>\n```",
		"- item\n  ```\n  code\n```\nList<T>\n```",
	],
	[
		"ordered list fence",
		"1. item\n   ```\n   x\n ```\nList<T>\n```",
		"1. item\n   ```\n   x\n ```\nList<T>\n```",
	],
	// GitHub links http(s):// and ftp:// after anything but a letter.
	["quoted URL", '"https://x.com/a<T>"', '"https://x.com/a<T>"'],
	["single-quoted URL", "'https://x.com/a<T>'", "'https://x.com/a<T>'"],
	["URL after a colon", "see:https://x.com/a<T>", "see:https://x.com/a<T>"],
	["URL after =", "a=https://x.com/a<T>", "a=https://x.com/a<T>"],
	["URL after a dot", "a.https://x.com/a<T>", "a.https://x.com/a<T>"],
	["URL after a digit", "1https://x.com/a<T>", "1https://x.com/a<T>"],
	["upper-case scheme", "HTTPS://x.com/a<T>", "HTTPS://x.com/a<T>"],
	["ftp", "ftp://x.com/a<T>", "ftp://x.com/a<T>"],
	["ftp after a colon", "x:ftp://x.com/a<T>", "x:ftp://x.com/a<T>"],
	["WWW is no link", "WWW.example.com/a<T>", "WWW.example.com/a\\<T>"],
	["URL then a new word", "https://x.com/a <T>", "https://x.com/a \\<T>"],
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

	// Each body as a function of `k`: k = 4 is the full body, about 64 KB,
	// and k = 1 holds about a quarter of its characters. CPU against four
	// quarter bodies (CLAUDE.md): linear is about 1x, quadratic 4x.
	const linear = (body: (k: number) => string, run: (text: string) => void) => {
		const full = body(4);
		const quarter = body(1);
		const { ratio } = bestCpuRatio(
			() => run(full),
			repeat(4, () => run(quarter)),
			3,
		);
		return ratio;
	};

	it.each([
		["unclosed processing instructions", (k: number) => "<?".repeat(7500 * k)],
		["unclosed declarations", (k: number) => "<!a".repeat(5000 * k)],
		["unclosed CDATA", (k: number) => "<![CDATA[".repeat(1750 * k)],
		["unclosed comments", (k: number) => "<!--".repeat(4000 * k)],
		[
			// Twice the runs hold four times the characters.
			"backtick runs of every length",
			(k: number) =>
				Array.from(
					{ length: 175 * Math.sqrt(k) },
					(_, i) => `${"`".repeat(i + 1)} <T> `,
				).join(""),
		],
		[
			"unclosed quotes",
			(k: number) => '<a b="'.repeat(2500 * k) + "<T>".repeat(500 * k),
		],
		["headings", (k: number) => "# <T>\n".repeat(2250 * k)],
		["URLs", (k: number) => "https://x<a".repeat(1500 * k)],
		[
			"a URL word, then <T>s",
			(k: number) => `https://x.com/a${"<T>".repeat(5000 * k)}`,
		],
		["schemes everywhere", (k: number) => "1https://".repeat(1750 * k)],
		[
			"a 64 KB mix",
			(k: number) =>
				[
					"<?",
					"<!a",
					"<![CDATA[",
					"<!--",
					'<a b="',
					"`".repeat(7),
					"https://x<T",
					"\\<T>",
					"<T>",
					"```\n",
					"> ",
				]
					.join(" ")
					.repeat(300 * k)
					.slice(0, 16_384 * k),
		],
	])("stays linear: %s", (name, body) => {
		const ratio = linear(body, (text) => unescapeTags(escapeTags(text)));
		console.info(
			`markdownEscape ${name}: 4x the body in ${ratio.toFixed(2)}x the CPU`,
		);
		expect(ratio).toBeLessThan(2);
	});

	it("stays linear on a long body", () => {
		const ratio = linear(
			(k) => "<a x='".repeat(500 * k) + "List<T> ".repeat(1250 * k),
			escapeTags,
		);
		console.info(
			`markdownEscape long body: 4x the body in ${ratio.toFixed(2)}x the CPU`,
		);
		expect(ratio).toBeLessThan(2);
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
			"https://",
			"www.",
			"</B>",
			"<?",
			"?>",
			"> ```\n",
			"    ```\n",
			"(",
			"<!x",
			'"',
			":",
			"ftp://",
			"WWW.",
			"1http://",
		];
		let seed = 7;
		const rand = () => {
			seed = (seed * 1103515245 + 12345) % 2 ** 31;
			return seed / 2 ** 31;
		};
		for (let n = 0; n < 6000; n++) {
			const len = 1 + Math.floor(rand() * 12);
			let x = "";
			for (let k = 0; k < len; k++)
				x += parts[Math.floor(rand() * parts.length)];
			const e = escapeTags(x);
			expect(escapeTags(unescapeTags(e)), JSON.stringify(x)).toBe(e);
		}
	});
});
