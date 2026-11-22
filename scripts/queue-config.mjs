// The machine's test queue setting (scripts/queue.mjs), read on every run so
// a change reaches running sessions at once:
//
//   ~/.config/carbonless/queue.json   {"slots": 1, "shortSlots": 1}
//
// No file: no queue. `slots`: how many test runs go at once (default 1),
// full or short. Keep it at 1: older copies of queue.mjs read it, and only
// slot 0 keeps them from running beside a full run. `shortSlots` (default
// 0): more slots for short runs only, read by this queue alone; with
// `slots`, at most half the cores but one (so every run gets a worker).
import { readFileSync } from "node:fs";
import { availableParallelism, homedir } from "node:os";
import { join } from "node:path";

/** $HOME as this thread sees it (a Vitest worker's own env too). */
export const home = () => process.env.HOME || homedir();

export const configPath = () =>
	join(home(), ".config", "carbonless", "queue.json");

/**
 * The cores the queue sizes its slots by. CRB_QUEUE_CORES (a positive whole
 * number) pins it, for tests only: queue.test.ts's runs must not depend on
 * the machine (CI's runners have 4 cores, the devbox 8).
 */
export function queueCores() {
	const pinned = Number(process.env.CRB_QUEUE_CORES);
	return Number.isInteger(pinned) && pinned >= 1
		? pinned
		: availableParallelism();
}

/** The config's JSON; null when there is none, {} when it isn't JSON. */
function config() {
	let text;
	try {
		text = readFileSync(configPath(), "utf8");
	} catch {
		return null;
	}
	try {
		const json = JSON.parse(text);
		return json && typeof json === "object" ? json : {};
	} catch {
		return {};
	}
}

/** Test runs allowed at once (`slots`); 0 when this machine has no queue. */
export function queueSlots() {
	const c = config();
	if (!c) return 0;
	const slots = c.slots ?? 1;
	return Number.isInteger(slots) && slots >= 1 ? slots : 1;
}

/**
 * Slots for short runs only (`shortSlots`); 0 when none or no queue. With
 * `slots`, at most half the budget (`cores` - 1), at least the one slot.
 */
export function shortSlots(cores = queueCores()) {
	const n = config()?.shortSlots ?? 0;
	if (!Number.isInteger(n) || n < 0) return 0;
	const most = Math.max(1, Math.floor((cores - 1) / 2));
	return Math.max(0, Math.min(n, most - queueSlots()));
}
