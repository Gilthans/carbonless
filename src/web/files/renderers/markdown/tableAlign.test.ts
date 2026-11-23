// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { alignTables, syncTableScroll } from "./tableAlign";

/*
 * Which tables tableAlign groups, and its scroll sync (CAR-167). Layout
 * (the widths) needs a browser: e2e/markdown-renderer.spec.ts.
 */

/** A document row: a table row block in the unified column, or a paragraph. */
const row = (kind: "head" | "row" | "text", id: string) => {
	const body =
		kind === "text"
			? `<p>${id}</p>`
			: `<div class="md-table" data-id="${id}"><table>${
					kind === "head" ? "<thead><tr><th>a</th></tr></thead>" : ""
				}<tbody><tr><td>${id}</td></tr></tbody></table></div>`;
	return `<div class="md-row"><div class="md-gutter"></div><div class="md-body" data-col="doc"><div class="md-content">${body}</div></div></div>`;
};

let root: HTMLElement;
const mount = (html: string) => {
	root = document.createElement("div");
	root.innerHTML = html;
	document.body.appendChild(root);
	root.addEventListener("scroll", syncTableScroll, true);
};
const box = (id: string) =>
	root.querySelector<HTMLElement>(`[data-id="${id}"]`) as HTMLElement;
const scroll = (id: string, x: number) => {
	box(id).scrollLeft = x;
	box(id).dispatchEvent(new Event("scroll"));
};

afterEach(() => {
	root.remove();
});

describe("syncTableScroll", () => {
	it("a table's rows scroll together; another table, or a row past a paragraph, doesn't", () => {
		mount(
			row("head", "h1") +
				row("row", "r1") +
				row("row", "r2") +
				row("text", "p") +
				row("head", "h2") +
				row("row", "s1"),
		);
		alignTables(root);
		scroll("r1", 40);
		expect(box("h1").scrollLeft).toBe(40);
		expect(box("r2").scrollLeft).toBe(40);
		expect(box("h2").scrollLeft).toBe(0);
		expect(box("s1").scrollLeft).toBe(0);
	});

	it("a box that left its group (aligned again) stops taking its old partners along", () => {
		mount(row("head", "h1") + row("row", "r1") + row("row", "r2"));
		alignTables(root);
		// r2 is now past a paragraph: its own, ungrouped.
		const p = document.createElement("div");
		p.innerHTML = row("text", "p");
		root.insertBefore(p.firstChild as Node, root.lastChild);
		alignTables(root);
		scroll("r2", 25);
		expect(box("h1").scrollLeft).toBe(0);
		expect(box("r1").scrollLeft).toBe(0);
		scroll("r1", 10);
		expect(box("h1").scrollLeft).toBe(10);
		expect(box("r2").scrollLeft).toBe(25);
	});
});
