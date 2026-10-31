import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { UPDATES } from "../../test/methodology-fixture";

// The matrix (test/methodology-matrix.ts) runs one file per way of keeping
// the branch current: a new one in UPDATES needs its file, or it goes
// untested.
describe("methodology matrix", () => {
	it("has a test file for every update", () => {
		const files = readdirSync(import.meta.dirname);
		for (const update of UPDATES) {
			expect(files).toContain(`methodology-${update}.test.ts`);
		}
	});
});
