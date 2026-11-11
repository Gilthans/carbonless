// On a machine with a test queue (queue-config.mjs), stops a Vitest or
// Playwright run started outside it. Loaded by vitest.config.ts and
// playwright.config.ts.
import { configPath, queueSlots } from "./queue-config.mjs";

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
 * Workers for a run holding a slot: the cores shared among the slots
 * (CRB_QUEUE_SLOTS, set by queue.mjs). undefined outside the queue: the
 * runner's own default.
 */
export function queuedWorkers(cores) {
	if (!process.env.CRB_QUEUE_HELD) return undefined;
	const slots = Number(process.env.CRB_QUEUE_SLOTS) || 1;
	return Math.max(1, Math.floor(cores / slots));
}
