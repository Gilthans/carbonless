/**
 * The Rendered view draws a Markdown table one row block at a time (each
 * row has its own bar and box), so each row is its own `<table>`. This
 * lines their columns up again (CAR-167): the tables of one Markdown table
 * in one column of the document (the unified document, or the old or new
 * column side by side) get the same column edges, and scroll together.
 *
 * A group is the run of rows whose body in that column holds a table; a
 * row with other content, or a fold, ends it, and a row whose table has a
 * header starts a new one (a table's first row block is its header). A
 * row with nothing in that column (an added row's old column) skips. The
 * widths only add room: a cell is never narrower than its own content, so
 * nothing is cut or hidden.
 */

const COLS = ["doc", "old", "new"] as const;

/** Each group's scroll boxes, by box: for the scroll sync. */
const groupOf = new WeakMap<HTMLElement, HTMLElement[]>();

function groups(root: HTMLElement): HTMLElement[][] {
	const out: HTMLElement[][] = [];
	const open = new Map<string, HTMLElement[]>();
	const end = (col: string) => {
		const g = open.get(col);
		if (g && g.length > 1) out.push(g);
		open.delete(col);
	};
	for (const row of root.children) {
		if (!row.classList.contains("md-row")) {
			for (const col of COLS) end(col);
			continue;
		}
		for (const col of COLS) {
			const body = row.querySelector<HTMLElement>(
				`:scope > .md-body[data-col="${col}"]`,
			);
			const contents = body
				? [...body.querySelectorAll<HTMLElement>(".md-content")]
				: [];
			if (contents.length === 0) {
				// A fold's row, or a row with nothing on this side: no table.
				if (!body && row.querySelector(":scope > .md-body")) end(col);
				continue;
			}
			const tables = contents.flatMap((c) => [
				...c.querySelectorAll<HTMLElement>("table"),
			]);
			if (tables.length === 0) {
				end(col);
				continue;
			}
			if (tables.some((t) => t.querySelector("thead"))) end(col);
			const g = open.get(col) ?? [];
			g.push(...tables);
			open.set(col, g);
		}
	}
	for (const col of COLS) end(col);
	return out;
}

/** A table's rows as their cells, a cell spanning columns left out. */
const cellsOf = (t: HTMLElement): HTMLElement[][] =>
	[...t.querySelectorAll("tr")].map((tr) =>
		[...tr.children].filter(
			(c): c is HTMLElement =>
				c instanceof HTMLElement && (c as HTMLTableCellElement).colSpan === 1,
		),
	);

/**
 * The group's tables, each laid out on its own as the page allows, give
 * each column the widest any of them took; then every table is laid out
 * fixed at those widths, each column's edge at the same place in the page
 * (a struck old row sits a little further in: its first column is that
 * much narrower). No column is narrower than any table's own needed it,
 * so no cell's content is cut or overlaps its neighbour.
 */
function align(tables: HTMLElement[]): void {
	const shape = tables.map((t) => {
		const rows = cellsOf(t);
		const box = t.parentElement;
		const first = rows.find((r) => r.length > 0)?.[0];
		const left = first
			? first.getBoundingClientRect().left + (box?.scrollLeft ?? 0)
			: undefined;
		const widths: number[] = [];
		for (const r of rows) {
			r.forEach((c, k) => {
				widths[k] = Math.max(widths[k] ?? 0, c.getBoundingClientRect().width);
			});
		}
		return { t, rows, left, widths };
	});
	const placed = shape.filter((s) => s.left !== undefined);
	const cols = Math.max(0, ...placed.map((s) => s.widths.length));
	// Column edges in the page: each the furthest any table needs.
	const starts = placed.map((s) => s.left as number);
	const wants = placed.map(() => [] as number[]);
	for (let k = 0; k < cols; k++) {
		let edge = 0;
		placed.forEach((s, i) => {
			const w = s.widths[k];
			if (w !== undefined) edge = Math.max(edge, (starts[i] as number) + w);
		});
		placed.forEach((s, i) => {
			if (s.widths[k] === undefined) return;
			(wants[i] as number[])[k] = edge - (starts[i] as number);
			starts[i] = edge;
		});
	}
	placed.forEach((s, i) => {
		const want = wants[i] as number[];
		if (want.length === 0) return;
		s.t.style.tableLayout = "fixed";
		s.t.style.width = `${want.reduce((a, b) => a + b, 0)}px`;
		s.t.setAttribute("data-md-w", "");
		for (const r of s.rows) {
			r.forEach((c, k) => {
				const w = want[k];
				if (w === undefined) return;
				c.style.boxSizing = "border-box";
				c.style.width = `${w}px`;
				c.setAttribute("data-md-w", "");
			});
		}
	});
}

/** Lines up the tables under `root` (MarkdownView's document), again from scratch. */
export function alignTables(root: HTMLElement): void {
	for (const c of root.querySelectorAll<HTMLElement>("[data-md-w]")) {
		c.style.width = "";
		c.style.boxSizing = "";
		c.style.tableLayout = "";
		c.removeAttribute("data-md-w");
	}
	for (const g of groups(root)) {
		align(g);
		const boxes = g.flatMap((t) => (t.parentElement ? [t.parentElement] : []));
		for (const b of boxes) groupOf.set(b, boxes);
	}
}

/**
 * A table scrolled sideways takes the rest of its group along (a capture
 * listener on the document: scroll events don't bubble).
 */
export function syncTableScroll(event: Event): void {
	const t = event.target;
	if (!(t instanceof HTMLElement) || !t.classList.contains("md-table")) return;
	for (const other of groupOf.get(t) ?? []) {
		if (other !== t && other.scrollLeft !== t.scrollLeft) {
			other.scrollLeft = t.scrollLeft;
		}
	}
}
