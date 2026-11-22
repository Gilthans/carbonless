// On a machine with a test queue (queue-config.mjs), stops a Vitest or
// Playwright run started outside it. Loaded by vitest.config.ts and
// playwright.config.ts.
import { freemem } from "node:os";
import { basename, dirname } from "node:path";
import { configPath, queueSlots, shortSlots } from "./queue-config.mjs";
import { tickets, writeWorkers } from "./queue-line.mjs";

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
 * Workers for a run holding a slot, decided when its runner starts
 * (workersFor), from the machine as it is then: the cores, the available
 * memory, how many runs the queue lets in at once, and the workers the
 * other runs holding a slot took (their tickets, queue-line.mjs). The main
 * runner process writes its count into its own ticket
 * ($CRB_QUEUE_MY_TICKET), so a run starting later leaves room for it.
 * undefined outside the queue: the runner's own default. Without a ticket
 * (an older queue.mjs waiting), the cores but one divided among the slots.
 */
export function queuedWorkers(cores, freeBytes = freemem()) {
	if (!process.env.CRB_QUEUE_HELD) return undefined;
	const mine = process.env.CRB_QUEUE_MY_TICKET;
	const line = mine ? tickets(dirname(mine)) : [];
	const me = line.find((t) => t.name === basename(mine ?? ""));
	if (!me) {
		const slots = Number(process.env.CRB_QUEUE_SLOTS) || 1;
		return workersFor({ cores, freeBytes, slots, full: true, others: [] });
	}
	const workers = workersFor({
		cores,
		freeBytes,
		slots: queueSlots() + shortSlots(),
		full: me.full,
		others: line.filter((t) => t.held && t !== me),
	});
	// Playwright loads the config in each worker too: only the main
	// process's count is the run's. (Vitest's workers don't load it.)
	if (!process.env.TEST_WORKER_INDEX) {
		writeWorkers(mine, workers);
	}
	return workers;
}

/** Memory a test worker may take, with its browser or its share of crb. */
export const WORKER_BYTES = 1.5 * 2 ** 30;
/** Workers a short run takes at most: one spec or a few files. */
export const SHORT_MAX = 3;

/**
 * Workers for a run, so that the runs holding a slot never take more than
 * the cores but one (the budget) together:
 * - a queue of one slot: the whole budget;
 * - a full run: the budget less a short run's share (S = a third of it,
 *   at least 1), and no more than what the others left;
 * - a short run: at most SHORT_MAX, and no more than what the others left,
 *   leaving at least one for a full run that may join it.
 * `others`: the other runs holding a slot; one whose runner hasn't said
 * yet counts as the most it may take. At most what the available memory
 * holds at WORKER_BYTES each; at least one. With 8 cores and 2 slots: a
 * full run 5, a short one beside it 2 (3 when first, the full one 4).
 */
export function workersFor({ cores, freeBytes, slots, full, others }) {
	const budget = Math.max(1, cores - 1);
	const short = Math.max(1, Math.round(budget / 3));
	const unsaid = (t) => (t.full ? budget - short : SHORT_MAX);
	const taken = others.reduce((n, t) => n + (t.workers ?? unsaid(t)), 0);
	const left = budget - taken;
	const most = full ? budget - short : Math.min(SHORT_MAX, budget - 1);
	const cpu = slots <= 1 ? budget : Math.min(most, left);
	const memory = Math.floor(freeBytes / WORKER_BYTES);
	return Math.max(1, Math.min(cpu, memory));
}
