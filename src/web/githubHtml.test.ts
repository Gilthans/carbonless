// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { sanitizeGithubHtml } from "./githubHtml";

const dom = (html: string) => {
	const div = document.createElement("div");
	div.innerHTML = sanitizeGithubHtml(html);
	return div;
};

describe("sanitizeGithubHtml", () => {
	it("keeps GitHub's markdown: headings, emphasis, task lists, tables, emoji", () => {
		const d = dom(
			'<div class="markdown-heading" dir="auto"><h2 class="heading-element" dir="auto">Summary</h2><a id="user-content-summary" class="anchor" aria-label="Permalink: Summary" href="#summary"><svg class="octicon octicon-link" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M7.775 3.275"></path></svg></a></div>' +
				'<p dir="auto">Caches <strong>widgets</strong> <g-emoji class="g-emoji" alias="tada">🎉</g-emoji></p>' +
				'<ul class="contains-task-list"><li class="task-list-item"><input type="checkbox" class="task-list-item-checkbox" checked=""> tested</li></ul>' +
				"<table><tr><td>a</td></tr></table>",
		);
		expect(d.querySelector("h2")?.textContent).toBe("Summary");
		expect(d.querySelector("h2")?.className).toBe("heading-element");
		expect(d.querySelector("strong")?.textContent).toBe("widgets");
		expect(d.textContent).toContain("🎉");
		const box = d.querySelector("input");
		expect(box?.checked).toBe(true);
		expect(box?.disabled).toBe(true);
		expect(d.querySelector("ul")?.className).toBe("contains-task-list");
		expect(d.querySelector("td")?.textContent).toBe("a");
		// The heading's permalink points into GitHub's page: dropped.
		expect(d.querySelector("a.anchor")).toBeNull();
		expect(d.querySelector("[id]")).toBeNull();
	});

	it("strips scripts, event handlers, styles and comments", () => {
		const d = dom(
			'<p>hi<script>window.pwned = 1</script><img src="https://x.example/a.png" onerror="window.pwned = 1"></p>' +
				'<p style="position:fixed" onclick="x()">styled</p><!-- hidden note --><style>body{display:none}</style>' +
				'<iframe src="https://evil.example"></iframe><form action="https://evil.example"><input name="q"></form>',
		);
		const html = d.innerHTML;
		expect(d.querySelector("script, style, iframe, form")).toBeNull();
		expect(html).not.toMatch(/onerror|onclick|style=|pwned|hidden note/);
		expect(html).not.toContain("<!--");
		expect(d.querySelector('input:not([type="checkbox"])')).toBeNull();
		expect(d.textContent).toContain("styled");
	});

	it("keeps only http(s) and mailto links, opening in a new tab without referrer", () => {
		const d = dom(
			'<a href="https://github.com/acme">ok</a>' +
				'<a href="mailto:a@b.example">mail</a>' +
				'<a href="javascript:alert(1)">js</a>' +
				'<a href="data:text/html,hi">data</a>' +
				'<a href="/acme/widget">relative</a>' +
				'<a href="#fn-1">1</a>',
		);
		const link = (text: string) =>
			[...d.querySelectorAll("a")].find((a) => a.textContent === text);
		expect(link("ok")).toHaveAttribute("href", "https://github.com/acme");
		expect(link("ok")).toHaveAttribute("target", "_blank");
		expect(link("ok")).toHaveAttribute("rel", "noreferrer noopener");
		expect(link("mail")).toHaveAttribute("href", "mailto:a@b.example");
		for (const text of ["js", "data", "relative", "1"]) {
			// The text stays; the link goes.
			expect(link(text)).toBeDefined();
			expect(link(text)).not.toHaveAttribute("href");
		}
	});

	it("loads images only from https", () => {
		const d = dom(
			'<img alt="https" src="https://camo.githubusercontent.com/abc">' +
				'<img alt="http" src="http://example.com/a.png">' +
				'<img alt="data" src="data:image/png;base64,AAAA">' +
				'<img alt="relative" src="/a.png">',
		);
		const imgs = [...d.querySelectorAll("img")];
		expect(imgs.map((i) => i.alt)).toEqual(["https"]);
		expect(imgs[0]).toHaveAttribute("referrerpolicy", "no-referrer");
	});

	it("drops classes github-markdown-css doesn't style, so content can't borrow the app's", () => {
		const d = dom(
			'<div class="fixed inset-0 z-50 markdown-alert markdown-alert-note"><p class="markdown-alert-title">Note</p></div><span class="bg-red-500">x</span>',
		);
		expect(d.querySelector("div")?.className).toBe(
			"markdown-alert markdown-alert-note",
		);
		expect(d.querySelector("span")).not.toHaveAttribute("class");
	});

	it("returns an empty string for empty input", () => {
		expect(sanitizeGithubHtml("")).toBe("");
	});
});
