import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SYNTAX, syntaxTheme } from "./files/syntaxTheme";

/** The color tokens, read from index.css's @theme block. */
const css = readFileSync(resolve(import.meta.dirname, "index.css"), "utf8");
const TOKENS = Object.fromEntries(
	[...css.matchAll(/--color-([a-z0-9-]+):\s*(#[0-9a-f]{6});/gi)].map((m) => [
		m[1],
		m[2],
	]),
) as Record<string, string>;

const token = (name: string): string => {
	const value = TOKENS[name];
	if (!value) throw new Error(`no --color-${name} in index.css`);
	return value;
};

const rgb = (hex: string) =>
	[1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));

function luminance(hex: string): number {
	const [r = 0, g = 0, b = 0] = rgb(hex).map((v) => {
		const c = v / 255;
		return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

/** `fg` at `alpha` over `bg`, like Tailwind's `bg-x/10` on a surface. */
function over(fg: string, alpha: number, bg: string): string {
	const f = rgb(fg);
	const b = rgb(bg);
	return `#${f
		.map((v, i) =>
			Math.round(v * alpha + (b[i] ?? 0) * (1 - alpha))
				.toString(16)
				.padStart(2, "0"),
		)
		.join("")}`;
}

const SURFACES = ["canvas", "surface", "raised"];

/** Hue in degrees, and the circular distance between two hues. */
function hue(hex: string): number {
	const [r = 0, g = 0, b = 0] = rgb(hex).map((v) => v / 255);
	const max = Math.max(r, g, b);
	const d = max - Math.min(r, g, b);
	if (d === 0) return 0;
	const h =
		max === r
			? ((g - b) / d) % 6
			: max === g
				? (b - r) / d + 2
				: (r - g) / d + 4;
	return (h * 60 + 360) % 360;
}
const hueGap = (a: string, b: string) => {
	const d = Math.abs(hue(a) - hue(b));
	return Math.min(d, 360 - d);
};

describe("color tokens", () => {
	it("text reads at 4.5:1 on every surface", () => {
		for (const text of ["ink", "ink-soft", "muted", "faint", "label", "link"]) {
			for (const bg of [...SURFACES, "overlay", "band"]) {
				expect(
					contrast(token(text), token(bg)),
					`${text} on ${bg}`,
				).toBeGreaterThanOrEqual(4.5);
			}
		}
	});

	it("the thread band sits between the surface and the raised comment", () => {
		// Thread-group bands and card headers: a step up from the surface,
		// below the comment's raised surface and the section's title band.
		const l = (name: string) => luminance(token(name));
		expect(l("band")).toBeGreaterThan(l("surface"));
		expect(l("band")).toBeLessThan(l("raised"));
		// Their status icons and the accent on a hint.
		for (const tone of ["ok", "warn", "accent", "label"]) {
			expect(
				contrast(token(tone), token("band")),
				`${tone} on band`,
			).toBeGreaterThanOrEqual(4.5);
		}
		// A badge (tone/10) inside a card header.
		for (const tone of ["ok", "bad", "warn", "done"]) {
			expect(
				contrast(token(tone), over(token(tone), 0.1, token("band"))),
				`${tone} badge on band`,
			).toBeGreaterThanOrEqual(4.5);
		}
	});

	it("a thread bubble's count and icons read closed and opened", () => {
		// ThreadBubble: a raised pill, pressed while open; the check (ok),
		// the alert and the your-turn dot (warn) on both.
		for (const bg of ["raised", "pressed"]) {
			for (const text of ["ink", "ink-soft", "muted"]) {
				expect(
					contrast(token(text), token(bg)),
					`${text} on ${bg}`,
				).toBeGreaterThanOrEqual(4.5);
			}
			for (const icon of ["ok", "warn"]) {
				expect(
					contrast(token(icon), token(bg)),
					`${icon} on ${bg}`,
				).toBeGreaterThanOrEqual(3);
			}
			expect(
				contrast(token("accent"), token(bg)),
				`the open border on ${bg}`,
			).toBeGreaterThanOrEqual(3);
		}
	});

	it("a commented line's tinted numbers read at 4.5:1 and its stripe stands out", () => {
		// thread-mark: accent at 20% over the number cells' own background.
		const numbers: [string, string][] = [
			["faint", "code"],
			["add-ink", "add-gutter"],
			["del-ink", "del-gutter"],
			["add-ink", "add-done"],
			["del-ink", "del-done"],
		];
		for (const [text, bg] of numbers) {
			expect(
				contrast(token(text), over(token("accent"), 0.2, token(bg))),
				`${text} on accent/20 over ${bg}`,
			).toBeGreaterThanOrEqual(4.5);
		}
		// The 3px stripe at the code's edge, over the 8% wash on each row kind.
		for (const bg of ["code", "add", "del", "add-done", "del-done"]) {
			expect(
				contrast(token("accent"), over(token("accent"), 0.08, token(bg))),
				`stripe on ${bg}`,
			).toBeGreaterThanOrEqual(3);
		}
	});

	it("a thread's comments error keeps its Retry link at 4.5:1", () => {
		// Conversation: the bad/10 notice over the card's surface.
		const tint = over(token("bad"), 0.1, token("surface"));
		expect(
			contrast(token("link"), tint),
			"link on bad/10 over surface",
		).toBeGreaterThanOrEqual(4.5);
	});

	it("status text and icons read at 4.5:1 on surfaces", () => {
		for (const text of ["ok", "bad", "warn", "done", "accent"]) {
			for (const bg of SURFACES) {
				expect(
					contrast(token(text), token(bg)),
					`${text} on ${bg}`,
				).toBeGreaterThanOrEqual(4.5);
			}
		}
	});

	it("tinted badges and notices keep their text at 4.5:1", () => {
		// Badge: tone/10 over the section surface; notices over the canvas.
		for (const tone of ["ok", "bad", "warn", "done"]) {
			for (const bg of ["surface", "canvas"]) {
				const tint = over(token(tone), 0.1, token(bg));
				expect(
					contrast(token(tone), tint),
					`${tone} on ${tone}/10 over ${bg}`,
				).toBeGreaterThanOrEqual(4.5);
			}
		}
		for (const [tone, text] of [
			["warn", "ink"],
			["accent", "ink"],
			["crossed", "done"],
		] as const) {
			const tint = over(token(tone), 0.2, token("surface"));
			expect(
				contrast(token(text), tint),
				`${text} on ${tone}/20`,
			).toBeGreaterThanOrEqual(4.5);
		}
	});

	it("controls, fills and indicators stand out at 3:1", () => {
		const parts = [
			"line-strong",
			"accent",
			"ok-fill",
			"crossed",
			"crossed-light",
			"unreviewed",
			"crossed-strong",
		];
		for (const part of parts) {
			for (const bg of [...SURFACES, "code"]) {
				expect(
					contrast(token(part), token(bg)),
					`${part} on ${bg}`,
				).toBeGreaterThanOrEqual(3);
			}
		}
		// Meter fills against their track.
		for (const fill of ["ok-fill", "crossed", "crossed-light"]) {
			expect(
				contrast(token(fill), token("overlay")),
				`${fill} on the meter track`,
			).toBeGreaterThanOrEqual(3);
		}
	});

	it("file change-kind icons stand out at 3:1 wherever a file is listed", () => {
		// File headers (raised), the tree on the sidebar and sheet, a hovered
		// row (overlay) and the current row (accent/12).
		const behind = [...SURFACES, "overlay"].map((n) => token(n));
		for (const bg of ["canvas", "surface"]) {
			behind.push(over(token("accent"), 0.12, token(bg)));
		}
		for (const kind of ["ok", "bad", "warn", "muted"]) {
			for (const bg of behind) {
				expect(
					contrast(token(kind), bg),
					`${kind} on ${bg}`,
				).toBeGreaterThanOrEqual(3);
			}
		}
	});

	it("a finished file's header and tree row keep their text and icons readable", () => {
		// FileDiff: the opaque ok-wash header (it sticks over the diff), and
		// the tree's finished row: ok/8 over the sidebar and the sheet.
		const l = (hex: string) => luminance(hex);
		expect(
			l(token("ok-wash")),
			"the wash reads as a tint, not a new surface",
		).toBeGreaterThan(l(token("raised")));
		const behind: [string, string][] = [["ok-wash", token("ok-wash")]];
		for (const bg of ["canvas", "surface"]) {
			behind.push([
				`finished row over ${bg}`,
				over(token("ok"), 0.08, token(bg)),
			]);
		}
		for (const [name, bg] of behind) {
			// Path, names, progress, fade marker, counts and status text.
			for (const text of [
				"ink",
				"ink-soft",
				"muted",
				"faint",
				"ok",
				"bad",
				"warn",
				"done",
			]) {
				expect(
					contrast(token(text), bg),
					`${text} on ${name}`,
				).toBeGreaterThanOrEqual(4.5);
			}
			// Button outlines, the focus ring, the left edge.
			for (const part of ["ok-fill", "crossed", "accent"]) {
				expect(
					contrast(token(part), bg),
					`${part} on ${name}`,
				).toBeGreaterThanOrEqual(3);
			}
			// A crossed-off file's reason badge.
			expect(
				contrast(token("done"), over(token("crossed"), 0.2, bg)),
				`done badge on ${name}`,
			).toBeGreaterThanOrEqual(4.5);
		}
	});

	it("the focus ring shows at 3:1 on everything it can sit on", () => {
		const behind = [
			...SURFACES,
			"overlay",
			"pressed",
			"code",
			"hunk",
			"add",
			"del",
			"add-done",
			"del-done",
			"add-gutter",
			"del-gutter",
		].map((name) => [name, token(name)] as const);
		// The tree's current row: accent/12 over the sidebar and the sheet.
		for (const bg of ["canvas", "surface"]) {
			behind.push([
				`current row over ${bg}`,
				over(token("accent"), 0.12, token(bg)),
			]);
		}
		for (const [name, color] of behind) {
			expect(contrast(token("accent"), color), name).toBeGreaterThanOrEqual(3);
		}
	});

	it("errors read on the hunk rows they can appear in", () => {
		expect(contrast(token("bad"), token("hunk"))).toBeGreaterThanOrEqual(4.5);
	});

	it("pressed and selected controls keep their label readable", () => {
		expect(
			contrast(token("ink"), token("crossed-strong")),
		).toBeGreaterThanOrEqual(4.5);
		expect(contrast(token("canvas"), token("accent"))).toBeGreaterThanOrEqual(
			4.5,
		);
		for (const end of ["cta-from", "cta-to"]) {
			expect(
				contrast(token("ink"), token(end)),
				`ink on ${end}`,
			).toBeGreaterThanOrEqual(4.5);
			// The progress chip inside "Review files": canvas/35 over the gradient.
			expect(
				contrast(token("ink"), over(token("canvas"), 0.35, token(end))),
				`ink on the chip over ${end}`,
			).toBeGreaterThanOrEqual(4.5);
		}
	});
});

describe("diff colors", () => {
	// Reviewed clusters keep full text contrast on their quieter tints.
	const CODE_BGS = ["code", "add", "del", "add-done", "del-done"];

	it("code text and every syntax color read at 4.5:1 on context, added and deleted lines", () => {
		for (const [name, color] of Object.entries(SYNTAX)) {
			for (const bg of CODE_BGS) {
				expect(
					contrast(color, token(bg)),
					`${name} on ${bg}`,
				).toBeGreaterThanOrEqual(4.5);
			}
		}
		for (const bg of CODE_BGS) {
			expect(contrast(token("code-ink"), token(bg))).toBeGreaterThanOrEqual(
				4.5,
			);
		}
	});

	it("line numbers and signs read at 4.5:1 in their gutters", () => {
		const pairs = [
			["faint", "code"],
			["add-ink", "add-gutter"],
			["add-ink", "add"],
			["del-ink", "del-gutter"],
			["del-ink", "del"],
			["add-ink", "add-done"],
			["del-ink", "del-done"],
			["hunk-ink", "hunk"],
		];
		for (const [fg = "", bg = ""] of pairs) {
			expect(
				contrast(token(fg), token(bg)),
				`${fg} on ${bg}`,
			).toBeGreaterThanOrEqual(4.5);
		}
	});

	it("invisible-character markers read at 4.5:1 on every code line", () => {
		// Muted markers and escapes (src/web/code); bidi controls on a warn tint.
		for (const bg of CODE_BGS) {
			expect(
				contrast(token("faint"), token(bg)),
				`faint on ${bg}`,
			).toBeGreaterThanOrEqual(4.5);
			const tint = over(token("warn"), 0.15, token(bg));
			expect(
				contrast(token("warn"), tint),
				`warn on warn/15 over ${bg}`,
			).toBeGreaterThanOrEqual(4.5);
		}
	});

	it("the commented-line tint (mark-tint, accent/8) keeps every code color readable", () => {
		// Over context, added and deleted lines, and their gutters' numbers.
		const tinted = (bg: string) => over(token("accent"), 0.08, token(bg));
		for (const [fg, bg] of [
			["add-ink", "add-gutter"],
			["del-ink", "del-gutter"],
		] as const) {
			expect(
				contrast(token(fg), tinted(bg)),
				`${fg} on tinted ${bg}`,
			).toBeGreaterThanOrEqual(4.5);
		}
		for (const bg of CODE_BGS) {
			const back = tinted(bg);
			for (const fg of ["code-ink", "faint", "add-ink", "del-ink"]) {
				expect(
					contrast(token(fg), back),
					`${fg} on tinted ${bg}`,
				).toBeGreaterThanOrEqual(4.5);
			}
			for (const [name, color] of Object.entries(SYNTAX)) {
				expect(
					contrast(color, back),
					`${name} on tinted ${bg}`,
				).toBeGreaterThanOrEqual(4.5);
			}
			// The focus ring still shows on it.
			expect(contrast(token("accent"), back)).toBeGreaterThanOrEqual(3);
		}
		// Added and deleted rows stay apart: tinted, the add row is still the
		// greenest and the delete row the reddest.
		const [ar = 0, ag = 0] = rgb(tinted("add"));
		const [dr = 0, dg = 0] = rgb(tinted("del"));
		expect(ag).toBeGreaterThan(ar);
		expect(dr).toBeGreaterThan(dg);
		expect(hueGap(tinted("add"), tinted("del"))).toBeGreaterThan(90);
	});

	it("keeps added green and deleted red apart from each other", () => {
		// Green: between yellow-green and teal; red: between magenta and red.
		for (const green of ["ok", "ok-fill", "add-ink"]) {
			expect(hue(token(green))).toBeGreaterThan(120);
			expect(hue(token(green))).toBeLessThan(165);
		}
		for (const red of ["bad", "del-ink"]) {
			expect(hue(token(red))).toBeGreaterThan(330);
		}
	});

	it("keeps every syntax hue at least 25° from the added and deleted inks", () => {
		for (const [name, color] of Object.entries(SYNTAX)) {
			for (const ink of ["add-ink", "del-ink"]) {
				expect(
					hueGap(color, token(ink)),
					`${name} vs ${ink}`,
				).toBeGreaterThanOrEqual(25);
			}
		}
	});
});

describe("literal colors that mirror tokens", () => {
	it("the theme-color meta is the header surface", () => {
		const html = readFileSync(
			resolve(import.meta.dirname, "index.html"),
			"utf8",
		);
		const meta = html.match(/name="theme-color" content="(#[0-9a-f]{6})"/i);
		expect(meta?.[1]?.toLowerCase()).toBe(token("surface"));
	});

	it("the syntax theme's background is the code background", () => {
		expect(syntaxTheme.colors?.["editor.background"]).toBe(token("code"));
	});
});
