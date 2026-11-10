// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import type { Hit } from "./findInPr";
import { hitSeen } from "./hitSeen";

const rect = (top: number, height = 20, left = 0, width = 100) =>
	({
		top,
		bottom: top + height,
		left,
		right: left + width,
		width,
		height,
		x: left,
		y: top,
	}) as DOMRect;

/**
 * File 1: its header's path painted current or not, and line 5 (new side)
 * and old line 7 in rows; `paint` says where the current hit is painted.
 */
function page(paint: "line5" | "path" | "header-other", top = 300) {
	document.body.innerHTML = `
		<section id="file-1">
			<header><span data-testid="file-path">src/<span ${paint === "path" ? "data-find-current" : ""}>save</span>.ts</span>
				<span ${paint === "header-other" ? "data-find-current" : ""}>save</span></header>
			<table><tbody>
				<tr data-old-no="7"><td><span data-code="">x</span></td></tr>
				<tr data-new-no="5"><td><span data-code="">a <span ${paint === "line5" ? "data-find-current" : ""}>save</span></span></td></tr>
			</tbody></table>
		</section>`;
	const header = document.querySelector("header") as HTMLElement;
	Object.defineProperty(header, "offsetHeight", { value: 40 });
	for (const el of document.querySelectorAll("[data-find-current]"))
		el.getBoundingClientRect = () => rect(top);
	Object.defineProperty(window, "innerHeight", {
		value: 800,
		configurable: true,
	});
}

const hit = (side: Hit["side"], line: number): Hit => ({
	index: 1,
	side,
	line,
	col: 2,
	len: 4,
});

describe("hitSeen", () => {
	afterEach(() => {
		document.body.innerHTML = "";
	});

	it("sees the hit painted current on its own line, below the stack, on screen", () => {
		page("line5");
		expect(hitSeen(hit("RIGHT", 5), 100)).toBe(true);
		// Under the stack (100) plus the file's header (40).
		page("line5", 120);
		expect(hitSeen(hit("RIGHT", 5), 100)).toBe(false);
		page("line5", 790);
		expect(hitSeen(hit("RIGHT", 5), 100)).toBe(false);
	});

	it("a current hit painted on another line or side (a trailing search's) isn't this hit", () => {
		page("line5");
		expect(hitSeen(hit("RIGHT", 6), 100)).toBe(false);
		expect(hitSeen(hit("LEFT", 5), 100)).toBe(false);
		expect(hitSeen(hit("path", 0), 100)).toBe(false);
	});

	it("a path hit is seen only in its file's path", () => {
		page("path");
		expect(hitSeen(hit("path", 0), 100)).toBe(true);
		expect(hitSeen(hit("RIGHT", 5), 100)).toBe(false);
		page("header-other");
		expect(hitSeen(hit("path", 0), 100)).toBe(false);
	});

	it("a hit the floating find bar covers isn't seen", () => {
		page("line5");
		const bar = document.createElement("div");
		bar.dataset.testid = "find-bar";
		bar.getBoundingClientRect = () => rect(290, 48, 50, 400);
		document.body.append(bar);
		expect(hitSeen(hit("RIGHT", 5), 100)).toBe(false);
		// Beside it, clear: seen.
		bar.getBoundingClientRect = () => rect(290, 48, 200, 400);
		expect(hitSeen(hit("RIGHT", 5), 100)).toBe(true);
	});
});
