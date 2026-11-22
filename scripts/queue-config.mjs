// The machine's test queue setting (scripts/queue.mjs), read on every run so
// a change reaches running sessions at once:
//
//   ~/.config/carbonless/queue.json   {"slots": 1, "shortSlots": 1}
//
// No file: no queue. `slots`: how many test runs go at once (default 1),
// full or short. `shortSlots` (default 0): more slots for short runs only,
// read by this queue alone (an older queue.mjs reads `slots`), so
// raising it never lets an older copy run beside a full run (queue.mjs).
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** $HOME as this thread sees it (a Vitest worker's own env too). */
export const home = () => process.env.HOME || homedir();

export const configPath = () =>
	join(home(), ".config", "carbonless", "queue.json");

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

/** Slots for short runs only (`shortSlots`); 0 when none or no queue. */
export function shortSlots() {
	const n = config()?.shortSlots ?? 0;
	return Number.isInteger(n) && n >= 0 ? n : 0;
}
