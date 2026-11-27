import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/*
 * The first render never waits on tracing (CAR-288 re-review S1): no
 * dynamic import of the trace code the app's render is chained on, which a
 * stalled chunk request (a phone, a tailscale reconnect) would leave blank.
 */
describe("main.tsx", () => {
	const main = readFileSync(join(__dirname, "..", "main.tsx"), "utf8");

	it("installs tracing synchronously, never behind an import the render waits for", () => {
		expect(main).not.toMatch(/import\(\s*["']\.\/trace/);
		expect(main).toMatch(
			/^import \{ installBrowserTrace \} from "\.\/trace\/install";$/m,
		);
		expect(main).toMatch(/renderAfter\(persistHome\(/);
	});
});
