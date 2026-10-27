/**
 * Two files whose diff git splits across context lines (a 4-space `}` on one
 * side byte-matches a different `}` on the other), used by the whitespace
 * unit test and e2e spec: `git diff -w` shows nothing for the re-indent and
 * only the `if` and its `}` for the wrap, and so should "Ignore whitespace".
 */

const REINDENT_BODY = [
	"export interface Item {",
	"  name: string;",
	"  price: number;",
	"  quantity: number;",
	"}",
	"",
	"export function total(items: Item[]): number {",
	"  let sum = 0;",
	"  for (const item of items) {",
	"    if (item.price < 0) {",
	`      throw new Error(\`negative price for \${item.name}\`);`,
	"    }",
	"    sum += item.price * item.quantity;",
	"  }",
	"  return sum;",
	"}",
	"",
	"export function average(items: Item[]): number {",
	"  if (items.length === 0) {",
	"    return 0;",
	"  }",
	"  return total(items) / items.length;",
	"}",
	"",
	"export function names(items: Item[]): string[] {",
	"  return items.map((item) => item.name);",
	"}",
];

const text = (lines: string[]) => `${lines.join("\n")}\n`;

/** 2-space indented. */
export const REINDENT_OLD = text(REINDENT_BODY);
/** The same, 4-space indented: whitespace only. */
export const REINDENT_NEW = text(
	REINDENT_BODY.map((l) => {
		const indent = l.length - l.trimStart().length;
		return `${" ".repeat(indent * 2)}${l.trimStart()}`;
	}),
);

const WRAP_BODY = [
	"export function flush(queue: Job[], log: (s: string) => void): void {",
	"  for (const job of queue) {",
	`    log(\`running \${job.id}\`);`,
	"    job.run();",
	"    if (job.failed) {",
	`      log(\`failed \${job.id}\`);`,
	"      job.retry();",
	"    }",
	`    log(\`done \${job.id}\`);`,
	"  }",
	"  queue.length = 0;",
	"}",
];

export const WRAP_OLD = text(WRAP_BODY);
/** The loop wrapped in `if (queue.length > 0) { … }`, its body indented by two. */
export const WRAP_NEW = text([
	WRAP_BODY[0] as string,
	"  if (queue.length > 0) {",
	...WRAP_BODY.slice(1, 10).map((l) => `  ${l}`),
	"  }",
	...WRAP_BODY.slice(10),
]);

/**
 * What the view shows the wrap as adding and removing: git put the true new
 * `  }` on a context row's new side, which no change row can carry, so the
 * smallest whitespace-only labelling blames the inner `}` and the moved
 * `log` line (it crossed an unchanged `}`): every other line is
 * whitespace-only.
 */
export const WRAP_ADDED = [
	"  if (queue.length > 0) {",
	"      }",
	`      log(\`done \${job.id}\`);`,
];
export const WRAP_REMOVED = [`    log(\`done \${job.id}\`);`];
