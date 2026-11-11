#!/usr/bin/env node
// pnpm test:e2e [playwright args...]: builds dist, then runs Playwright on it
// in its turn (scripts/queue.mjs). No run changes a dist another run in this
// tree is serving (scripts/dist-lock.mjs, CAR-117): the build holds the
// tree's dist lock alone, and the run holds it shared from its turn to its
// end. The build goes before the queue, so it overlaps the wait for a turn;
// it waits only for runs of this tree that are serving dist.
import { join } from "node:path";
import { run as runChild } from "./run-child.mjs";

const run = (c, a) => runChild("test:e2e", c, a);
const script = (name) => join(import.meta.dirname, name);

const built = await run("pnpm", ["build"]);
if (built !== 0) process.exit(built);
process.exit(
	await run(process.execPath, [
		script("queue.mjs"),
		process.execPath,
		script("dist-lock.mjs"),
		"--shared",
		"pnpm",
		"exec",
		"playwright",
		"test",
		...process.argv.slice(2),
	]),
);
