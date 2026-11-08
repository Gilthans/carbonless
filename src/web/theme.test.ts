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
/** How far from grey, 0 to 1. */
const chroma = (hex: string) => {
	const c = rgb(hex);
	return (Math.max(...c) - Math.min(...c)) / 255;
};
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

	it("a thread's exact span (span-mark) keeps every code color at 4.5:1 and its underline shows", () => {
		// Opaque: the same over context, added and deleted rows.
		const back = token("span");
		for (const fg of ["code-ink", "faint", "add-ink", "del-ink"]) {
			expect(contrast(token(fg), back), `${fg} on span`).toBeGreaterThanOrEqual(
				4.5,
			);
		}
		for (const [name, color] of Object.entries(SYNTAX)) {
			expect(contrast(color, back), `${name} on span`).toBeGreaterThanOrEqual(
				4.5,
			);
		}
		expect(contrast(token("accent"), back)).toBeGreaterThanOrEqual(3);
		// It stands apart from the lines' own wash on every row kind.
		for (const bg of ["code", "add", "del", "add-done", "del-done"]) {
			const row = over(token("accent"), 0.08, token(bg));
			const dist = Math.hypot(
				...rgb(back).map((v, i) => v - (rgb(row)[i] ?? 0)),
			);
			expect(dist, `span apart from ${bg}`).toBeGreaterThan(40);
		}
	});

	it("a find hit (find-mark) keeps every code color at 4.5:1 and stands apart from span-mark and the row washes", () => {
		const back = token("find");
		for (const fg of ["code-ink", "faint", "add-ink", "del-ink"]) {
			expect(contrast(token(fg), back), `${fg} on find`).toBeGreaterThanOrEqual(
				4.5,
			);
		}
		for (const [name, color] of Object.entries(SYNTAX)) {
			expect(contrast(color, back), `${name} on find`).toBeGreaterThanOrEqual(
				4.5,
			);
		}
		const apart = (other: number[]) =>
			Math.hypot(...rgb(back).map((v, i) => v - (other[i] ?? 0)));
		expect(apart(rgb(token("span"))), "find apart from span").toBeGreaterThan(
			40,
		);
		for (const bg of ["code", "add", "del", "add-done", "del-done"]) {
			const row = over(token("accent"), 0.08, token(bg));
			expect(apart(rgb(row)), `find apart from ${bg}`).toBeGreaterThan(40);
		}
	});

	it("the current find hit (find-current) reads canvas on orange at 4.5:1", () => {
		expect(contrast(token("canvas"), token("orange"))).toBeGreaterThanOrEqual(
			4.5,
		);
	});

	it("picked line numbers (line-picked, accent/35) read at 4.5:1", () => {
		for (const bg of [
			"code",
			"add-gutter",
			"del-gutter",
			"add-done",
			"del-done",
		]) {
			expect(
				contrast(token("ink"), over(token("accent"), 0.35, token(bg))),
				`ink on accent/35 over ${bg}`,
			).toBeGreaterThanOrEqual(4.5);
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

	it("the save notices keep their text and icons at 4.5:1", () => {
		// SyncNotices: tone/10 over an opaque raised card.
		for (const [tone, texts] of [
			["warn", ["ink", "muted", "warn"]],
			["bad", ["ink", "bad", "ink-soft"]],
		] as const) {
			const tint = over(token(tone), 0.1, token("raised"));
			for (const text of texts) {
				expect(
					contrast(token(text), tint),
					`${text} on ${tone}/10 over raised`,
				).toBeGreaterThanOrEqual(4.5);
			}
		}
	});

	it("thread write notices, warnings and the reply box read at 4.5:1", () => {
		// SyncNotices' thread writes: the "Open on GitHub" link on bad/10
		// over raised.
		expect(
			contrast(token("link"), over(token("bad"), 0.1, token("raised"))),
			"link on bad/10 over raised",
		).toBeGreaterThanOrEqual(4.5);
		// WriteWarnings: warn/10 over the section's surface; ink text, the
		// link, and the warn icon.
		const warning = over(token("warn"), 0.1, token("surface"));
		for (const text of ["ink", "link", "warn"]) {
			expect(
				contrast(token(text), warning),
				`${text} on warn/10 over surface`,
			).toBeGreaterThanOrEqual(4.5);
		}
		// ReplyBox: text and placeholder on raised; its Send icon (link) on
		// the card surface and the Files row canvas, faint while disabled.
		for (const text of ["ink", "faint"]) {
			expect(
				contrast(token(text), token("raised")),
				`${text} on raised`,
			).toBeGreaterThanOrEqual(4.5);
		}
		for (const bg of ["surface", "canvas", "overlay"]) {
			expect(
				contrast(token("link"), token(bg)),
				`link on ${bg}`,
			).toBeGreaterThanOrEqual(4.5);
		}
		// OrphanDraft's Discard (bad) and the header's muted text, on band
		// and on an overlay hover.
		for (const icon of ["ok", "muted", "bad", "ink-soft"]) {
			for (const bg of ["band", "overlay"]) {
				expect(
					contrast(token(icon), token(bg)),
					`${icon} on ${bg}`,
				).toBeGreaterThanOrEqual(4.5);
			}
		}
	});

	it("the Resolve button reads at 4.5:1 wherever a thread opens", () => {
		// ResolveButton: Resolve is ok text on ok/10 (ok/20 hovered), Unresolve
		// ink-soft (ink hovered, on overlay), on an Overview card (surface)
		// and in Files changed (a surface card on the canvas row).
		for (const bg of ["surface", "canvas"]) {
			for (const alpha of [0.1, 0.2]) {
				expect(
					contrast(token("ok"), over(token("ok"), alpha, token(bg))),
					`ok on ok/${alpha * 100} over ${bg}`,
				).toBeGreaterThanOrEqual(4.5);
			}
			expect(
				contrast(token("ink-soft"), token(bg)),
				`ink-soft on ${bg}`,
			).toBeGreaterThanOrEqual(4.5);
			// Its outline: ok/60 for Resolve, line-strong for Unresolve.
			expect(
				contrast(over(token("ok"), 0.6, token(bg)), token(bg)),
				`ok/60 outline on ${bg}`,
			).toBeGreaterThanOrEqual(3);
		}
		expect(contrast(token("ink"), token("overlay"))).toBeGreaterThanOrEqual(
			4.5,
		);
	});

	it("each person's tint keeps comment text at 4.5:1 and stays clear of add, delete and warn", () => {
		const people = Object.keys(TOKENS).filter((n) => /^person-\d+$/.test(n));
		expect(people.length).toBeGreaterThanOrEqual(7);
		// The deleted/failing reds well clear; the add/ok green and the
		// warn yellow clear.
		const conventions: [string, number][] = [
			["del", 40],
			["del-ink", 40],
			["bad", 40],
			["add", 25],
			["add-ink", 25],
			["ok", 25],
			["warn", 25],
		];
		for (const wash of people) {
			const edge = `${wash}-edge`;
			// GitHub's text on the wash: body, names, quotes, links.
			for (const text of ["ink", "ink-soft", "muted", "faint", "link"]) {
				expect(
					contrast(token(text), token(wash)),
					`${text} on ${wash}`,
				).toBeGreaterThanOrEqual(4.5);
			}
			// The avatar fallback's initial on the edge color.
			expect(
				contrast(token("ink"), token(edge)),
				`ink on ${edge}`,
			).toBeGreaterThanOrEqual(4.5);
			// A tint, not a new surface: apart from raised, but quietly.
			const step = contrast(token(wash), token("raised"));
			expect(step, `${wash} vs raised`).toBeGreaterThan(1.1);
			expect(step, `${wash} vs raised`).toBeLessThan(1.5);
			// Hued ones away from the conventions' hues; a near-grey (stone)
			// has no hue to be taken for one.
			for (const c of [wash, edge].filter((c) => chroma(token(c)) >= 0.1)) {
				for (const [conv, floor] of conventions) {
					expect(
						hueGap(token(c), token(conv)),
						`${c} hue vs ${conv}`,
					).toBeGreaterThanOrEqual(floor);
				}
			}
		}
		// Every two people apart, wash or edge.
		for (const [i, a] of people.entries()) {
			for (const b of people.slice(i + 1)) {
				expect(
					token(a) !== token(b) && token(`${a}-edge`) !== token(`${b}-edge`),
					`${a} vs ${b}`,
				).toBe(true);
			}
		}
	});

	it("Home's rows, popovers and open box keep their text and icons readable", () => {
		// The open box's list and the row popovers: overlay, the highlighted
		// option pressed; marked title words (link), state icons, hints
		// (muted: faint only for the group headings, never on pressed).
		expect(contrast(token("faint"), token("overlay"))).toBeGreaterThanOrEqual(
			4.5,
		);
		for (const bg of ["overlay", "pressed"]) {
			for (const text of ["ink", "ink-soft", "muted", "link", "done", "bad"]) {
				expect(
					contrast(token(text), token(bg)),
					`${text} on ${bg}`,
				).toBeGreaterThanOrEqual(4.5);
			}
		}
		// A hovered row (raised): its status icons and the turn's arrow.
		for (const tone of ["ok", "bad", "warn", "done", "accent", "faint"]) {
			expect(
				contrast(token(tone), token("raised")),
				`${tone} on raised`,
			).toBeGreaterThanOrEqual(4.5);
		}
		// The snooze date's OK button: canvas on accent.
		expect(contrast(token("canvas"), token("accent"))).toBeGreaterThanOrEqual(
			4.5,
		);
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
		// On a finished file's header (ok-wash): the outlines and fills that
		// show there. The pressed cross-off's crossed-strong fill is edged in
		// crossed; unreviewed never shows on a finished file.
		for (const part of [
			"line-strong",
			"accent",
			"ok-fill",
			"crossed",
			"crossed-light",
		]) {
			expect(
				contrast(token(part), token("ok-wash")),
				`${part} on ok-wash`,
			).toBeGreaterThanOrEqual(3);
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

	/** Every color code is drawn in: the code, markers and signs, then each syntax color. */
	const CODE_COLORS = [
		["code-ink", token("code-ink")],
		["faint", token("faint")],
		["add-ink", token("add-ink")],
		["del-ink", token("del-ink")],
		...Object.entries(SYNTAX),
	] as const;
	/** No wash, a thread's or a landing's (mark-tint, accent/8), a pick's (line-picked, accent/10). */
	const WASHES = [0, 0.08, 0.1] as const;
	const washed = (bg: string, wash: number) =>
		wash ? over(token("accent"), wash, bg) : bg;

	it("word marks are the owner's brighter tints, never less readable than when chosen, and stay add/del", () => {
		// The owner chose GitHub-like bright marks over 4.5:1 for every color
		// (2026-11-02, after comparing four options): "(d) seems much less
		// visible than (c). Let's go with (c) please". Some code colors fall
		// below 4.5:1 on them (the faint dots and comments most). Each color's
		// contrast on each mark, under each wash, is pinned at what it was
		// then (rounded down): a change may raise it, never lower it.
		// Order: CODE_COLORS.
		const FLOORS: Record<string, Record<(typeof WASHES)[number], number[]>> = {
			"add-word": {
				0: [
					6.4, 2.81, 5.34, 3.87, 6.4, 2.85, 3.87, 5.75, 4.13, 4.65, 4.01, 5.47,
					4.03, 4.58,
				],
				0.08: [
					5.77, 2.53, 4.81, 3.49, 5.77, 2.57, 3.49, 5.18, 3.73, 4.19, 3.62,
					4.93, 3.64, 4.13,
				],
				0.1: [
					5.59, 2.45, 4.66, 3.38, 5.59, 2.49, 3.38, 5.02, 3.61, 4.06, 3.51,
					4.78, 3.52, 4,
				],
			},
			"del-word": {
				0: [
					9.32, 4.09, 7.78, 5.64, 9.32, 4.16, 5.63, 8.37, 6.02, 6.77, 5.85,
					7.97, 5.88, 6.67,
				],
				0.08: [
					8.3, 3.64, 6.92, 5.02, 8.3, 3.7, 5.01, 7.45, 5.36, 6.03, 5.21, 7.1,
					5.23, 5.94,
				],
				0.1: [
					8.01, 3.51, 6.68, 4.85, 8.01, 3.57, 4.84, 7.2, 5.18, 5.82, 5.03, 6.85,
					5.05, 5.73,
				],
			},
			"add-word-done": {
				0: [
					7.94, 3.48, 6.62, 4.8, 7.94, 3.54, 4.8, 7.13, 5.13, 5.77, 4.98, 6.79,
					5.01, 5.68,
				],
				0.08: [
					7.04, 3.09, 5.88, 4.26, 7.04, 3.14, 4.26, 6.33, 4.55, 5.12, 4.42,
					6.02, 4.44, 5.04,
				],
				0.1: [
					6.8, 2.98, 5.67, 4.11, 6.8, 3.03, 4.11, 6.11, 4.39, 4.94, 4.27, 5.81,
					4.29, 4.86,
				],
			},
			"del-word-done": {
				0: [
					10.01, 4.39, 8.35, 6.06, 10.01, 4.46, 6.05, 8.99, 6.47, 7.28, 6.28,
					8.56, 6.32, 7.17,
				],
				0.08: [
					8.74, 3.84, 7.29, 5.29, 8.74, 3.9, 5.28, 7.85, 5.65, 6.35, 5.49, 7.48,
					5.52, 6.26,
				],
				0.1: [
					8.42, 3.69, 7.02, 5.09, 8.42, 3.75, 5.09, 7.56, 5.44, 6.12, 5.28, 7.2,
					5.31, 6.02,
				],
			},
		};
		// A pair's changed tokens (CodeLine `words`): a stronger tint of the
		// line's own color, on live and reviewed rows; a thread's, a
		// landing's or a pick's wash shows over them (--wash).
		const WORDS = [
			["add-word", "add", "del"],
			["del-word", "del", "add"],
			["add-word-done", "add-done", "del-done"],
			["del-word-done", "del-done", "add-done"],
		] as const;
		const dist = (a: string, b: string) =>
			Math.hypot(...rgb(a).map((v, i) => v - (rgb(b)[i] ?? 0)));
		for (const [word, own, other] of WORDS) {
			for (const wash of WASHES) {
				const back = washed(token(word), wash);
				CODE_COLORS.forEach(([name, color], i) => {
					expect(
						contrast(color, back),
						`${name} on ${word} under accent/${wash * 100}`,
					).toBeGreaterThanOrEqual(FLOORS[word]?.[wash]?.[i] ?? 4.5);
				});
			}
			// Its own kind's hue, and it stands out from its row.
			expect(
				dist(token(word), token(own)),
				`${word} nearer ${own} than ${other}`,
			).toBeLessThan(dist(token(word), token(other)));
			expect(
				dist(token(word), token(own)),
				`${word} on ${own}`,
			).toBeGreaterThan(12);
			expect(
				chroma(token(word)),
				`${word} stronger than ${own}`,
			).toBeGreaterThan(chroma(token(own)));
		}
	});

	it("rows keep every code color at 4.5:1 under no wash, a thread's and a pick's", () => {
		// Known gap, from before word marks: a pick's wash (accent/10) on an
		// added row leaves the faint dots and comments just under 4.5:1.
		// Pinned so it can't get worse.
		const GAPS: Record<string, number> = {
			"add 0.1 faint": 4.41,
			"add 0.1 comment": 4.48,
		};
		for (const bg of CODE_BGS) {
			for (const wash of WASHES) {
				const back = washed(token(bg), wash);
				for (const [name, color] of CODE_COLORS) {
					expect(
						contrast(color, back),
						`${name} on ${bg} under accent/${wash * 100}`,
					).toBeGreaterThanOrEqual(GAPS[`${bg} ${wash} ${name}`] ?? 4.5);
				}
			}
		}
	});

	it("a thread's or a pick's wash shows over word marks", () => {
		// The washes are inset shadows on the cells, painted under the cell's
		// content: a word mark's background would hide them. Each wash names
		// its color --wash (on the cells it washes) and paints with it, and a
		// word mark layers --wash over its own tint.
		const utility = (name: string) => {
			const at = css.indexOf(`@utility ${name} {`);
			expect(at, `@utility ${name}`).toBeGreaterThanOrEqual(0);
			let depth = 0;
			for (let i = css.indexOf("{", at); i < css.length; i++) {
				if (css[i] === "{") depth++;
				else if (css[i] === "}" && --depth === 0) return css.slice(at, i + 1);
			}
			throw new Error(`unclosed @utility ${name}`);
		};
		for (const name of [
			"mark-tint",
			"mark-tint-cell",
			"thread-mark",
			"thread-mark-cell",
			"line-picked",
			"line-picked-cell",
		]) {
			const body = utility(name);
			// Every 100vmax wash shadow is var(--wash), and --wash is set.
			expect(body, name).toMatch(/--wash:\s*color-mix\(/);
			const washes = [...body.matchAll(/inset 0 0 0 100vmax\s+([^;,]+)/g)];
			expect(washes.length, name).toBeGreaterThan(0);
			for (const [, color] of washes)
				expect(color?.trim(), name).toBe("var(--wash)");
		}
		expect(css).toMatch(/@property --wash \{[^}]*inherits: true/);
		expect(css).toMatch(
			/\[data-word\] \{[^}]*background-image: linear-gradient\(\s*var\(--wash\),\s*var\(--wash\)\s*\)/,
		);
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

describe("sticky stack", () => {
	it("drops the page's scroll padding while the find box has focus (typing would scroll to the top), and for no other box", () => {
		const rule = css.match(/html:has\(([^)]*)\)\s*\{([^}]*)\}/);
		expect(rule?.[1]?.trim()).toBe("[data-find-box]:focus");
		expect(rule?.[2]).toMatch(/scroll-padding-top:\s*0;/);
	});
});
