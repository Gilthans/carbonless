// On a machine with a test queue (queue-config.mjs), stops a Vitest or
// Playwright run started outside it. Loaded by vitest.config.ts and
// playwright.config.ts.
import { freemem } from "node:os";
import { join } from "node:path";
import { configPath, home, queueSlots } from "./queue-config.mjs";
import { sharing } from "./queue-line.mjs";

/**
 * Throws when this machine has a queue and this process neither runs inside
 * it (CRB_QUEUE_HELD) nor was told to skip it (CRB_NO_QUEUE). `how` names the
 * queued command to use instead.
 */
export function requireQueue(how) {
	if (process.env.CRB_QUEUE_HELD || process.env.CRB_NO_QUEUE) return;
	if (!queueSlots()) return;
	throw new Error(
		`This machine queues test runs (${configPath()}): run \`${how}\` (or \`node scripts/queue.mjs <command>\`). CRB_NO_QUEUE=1 skips the queue.`,
	);
}

/**
 * Workers for a run holding a slot, decided when its runner starts, from
 * the machine as it is then: the cores but one (left for the machine's
 * other work) shared among the runs holding a slot now (their tickets,
 * queue-line.mjs; CRB_QUEUE_SLOTS, set by queue.mjs, when the line can't
 * say), and no more than the available memory holds (workersFor).
 * undefined outside the queue: the runner's own default.
 */
export function queuedWorkers(cores, freeBytes = freemem()) {
	if (!process.env.CRB_QUEUE_HELD) return undefined;
	const held = sharing(join(home(), ".cache", "carbonless-queue"));
	return workersFor({
		cores,
		sharing: held || Number(process.env.CRB_QUEUE_SLOTS) || 1,
		freeBytes,
	});
}

/** Memory a test worker may take, with its browser or its share of crb. */
export const WORKER_BYTES = 1.5 * 2 ** 30;

/**
 * Workers for one of `sharing` runs on `cores` with `freeBytes` of memory
 * available: (cores - 1) / sharing, and at most freeBytes / WORKER_BYTES;
 * at least one.
 */
export function workersFor({ cores, sharing, freeBytes }) {
	const cpu = Math.floor((cores - 1) / Math.max(1, sharing));
	const memory = Math.floor(freeBytes / WORKER_BYTES);
	return Math.max(1, Math.min(cpu, memory));
}
