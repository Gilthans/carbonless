// The fake gh as a process of its own: what test/fake-gh/gh runs when no
// fake gh server answers (server.mjs), e.g. outside a test runner.
import { readFileSync } from "node:fs";
import { fakeGh } from "./gh.mjs";
import { traceCall } from "./trace.mjs";

const args = process.argv.slice(2);
traceCall(args);
const code = await fakeGh({
	args,
	env: process.env,
	cwd: process.cwd(),
	stdin: () => readFileSync(0, "utf8"),
	out: (text) => process.stdout.write(text),
	err: (text) => process.stderr.write(text),
});
process.exitCode = code;
