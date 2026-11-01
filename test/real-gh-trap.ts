import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

/**
 * Vitest global setup: "tests never call the real gh". A trap `gh` goes first
 * on PATH for the whole run (workers and every process they start inherit
 * it), so a call that escapes the fake gh (a fixture's PATH restored while a
 * call is still to start) lands here instead of on the machine's logged-in
 * gh. The trap records the call and exits 1; teardown fails the run when
 * anything was recorded. Tests put the fake gh in front of the trap.
 */
export default function setup() {
	const dir = mkdtempSync(join(tmpdir(), "crb-real-gh-trap-"));
	const log = join(dir, "calls.log");
	const gh = join(dir, "gh");
	const q = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
	writeFileSync(
		gh,
		`#!/bin/sh
# Stands in for the real gh during unit tests (test/real-gh-trap.ts).
{
	printf 'gh'; for a in "$@"; do printf ' %s' "$a"; done; printf '\\n'
	printf '  test: %s > %s\\n' "\${CRB_TEST_FILE:-?}" "\${CRB_TEST_NAME:-?}"
	printf '  cwd: %s; CRB_FAKE_GH: %s\\n' "$PWD" "\${CRB_FAKE_GH:-unset}"
} >> ${q(log)}
echo "real gh trap: tests must not call the real gh" >&2
exit 1
`,
	);
	chmodSync(gh, 0o755);
	process.env.PATH = `${dir}${delimiter}${process.env.PATH ?? ""}`;
	return () => {
		const calls = existsSync(log) ? readFileSync(log, "utf8") : "";
		rmSync(dir, { recursive: true, force: true });
		if (calls) {
			throw new Error(`Tests reached the real gh:\n${calls}`);
		}
	};
}
