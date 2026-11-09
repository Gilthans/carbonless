// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AgentMarkdown } from "./AgentMarkdown";

afterEach(cleanup);

function show(text: string) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, enabled: false } },
	});
	return render(
		<QueryClientProvider client={client}>
			<AgentMarkdown text={text} />
		</QueryClientProvider>,
	).container;
}

describe("AgentMarkdown", () => {
	it("renders GitHub-flavored tables and lists", () => {
		const el = show(
			"| a | b |\n| - | - |\n| 1 | 2 |\n\n- one\n- two\n- [x] done",
		);
		expect(el.querySelector("table")).not.toBeNull();
		expect(el.querySelectorAll("td")).toHaveLength(2);
		expect(el.querySelectorAll("li")).toHaveLength(3);
		expect(el.querySelector(".markdown-body")).not.toBeNull();
	});

	it("draws a fenced block in a known language as code rows", () => {
		const el = show(
			"Before\n\n```ts\nconst a = 1;\nconst b = 2;\n```\n\nAfter",
		);
		const rows = el.querySelectorAll('[data-testid="agent-code-line"]');
		expect(rows).toHaveLength(2);
		expect(rows[0]?.textContent).toContain("const a = 1;");
		// The prose around it still renders, in order.
		expect(el.textContent?.indexOf("Before")).toBeLessThan(
			el.textContent?.indexOf("const a") ?? -1,
		);
		expect(el.textContent).toContain("After");
	});

	it("draws a diff fence as added and deleted rows", () => {
		const el = show("```diff\n-  for (let i = 1;\n+  for (let i = 0;\n```");
		const rows = [
			...el.querySelectorAll<HTMLElement>('[data-testid="agent-code-line"]'),
		];
		expect(rows.map((r) => r.className.includes("bg-del"))).toEqual([
			true,
			false,
		]);
		expect(rows[1]?.className).toContain("bg-add");
	});

	it("keeps a fence in an unknown language as plain code", () => {
		const el = show("```zzz\nwhatever <b>x</b>\n```");
		expect(el.querySelector('[data-testid="agent-code-line"]')).toBeNull();
		expect(el.querySelector("pre code")?.textContent).toContain(
			"whatever <b>x</b>",
		);
		expect(el.querySelector("pre b")).toBeNull();
	});

	it("hostile Markdown renders nothing executable", () => {
		const el = show(
			[
				"<script>window.pwned = 1</script>",
				'<img src=x onerror="window.pwned = 2">',
				"[x](javascript:alert(1))",
				'<a href="https://e.com" onclick="window.pwned = 3">e</a>',
				"<style>body { display: none }</style>",
				'<iframe src="https://e.com"></iframe>',
				"![pic](http://insecure.example/a.png)",
			].join("\n\n"),
		);
		const html = el.innerHTML;
		expect(el.querySelector("script, style, iframe")).toBeNull();
		expect(html).not.toMatch(/onerror|onclick/i);
		expect(html).not.toMatch(/javascript:/i);
		expect(el.querySelector('img[src^="http:"]')).toBeNull();
		const link = el.querySelector('a[href="https://e.com/"]');
		expect(link).not.toBeNull();
		expect(link?.getAttribute("rel")).toBe("noreferrer noopener");
		expect((window as { pwned?: number }).pwned).toBeUndefined();
	});

	it("keeps an https image", () => {
		const el = show("![chart](https://example.com/c.png)");
		expect(
			el.querySelector('img[src="https://example.com/c.png"]'),
		).not.toBeNull();
	});

	it("renders a partial answer while it streams", () => {
		const el = show("No. The loop starts at **index 1** and\n\n```ts\nfor (");
		expect(el.querySelector("strong")?.textContent).toBe("index 1");
		expect(el.textContent).toContain("for (");
	});
});
