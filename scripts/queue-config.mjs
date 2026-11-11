// The machine's test queue setting (scripts/queue.mjs), read on every run so
// a change reaches running sessions at once:
//
//   ~/.config/carbonless/queue.json   {"slots": 2}
//
// No file: no queue. `slots`: how many test runs go at once (default 1).
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** $HOME as this thread sees it (a Vitest worker's own env too). */
export const home = () => process.env.HOME || homedir();

export const configPath = () =>
	join(home(), ".config", "carbonless", "queue.json");

/** Test runs allowed at once; 0 when this machine has no queue. */
export function queueSlots() {
	let text;
	try {
		text = readFileSync(configPath(), "utf8");
	} catch {
		return 0;
	}
	let slots;
	try {
		slots = JSON.parse(text).slots ?? 1;
	} catch {
		slots = 1;
	}
	return Number.isInteger(slots) && slots >= 1 ? slots : 1;
}
