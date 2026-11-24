export function startTime(pid: number): string;
export function ticketState(
	content: string,
): "live" | "dead" | "stopped" | "foreign";
export function line(dir: string): string[];
export type Ticket = {
	name: string;
	old?: boolean;
	full: boolean;
	held: boolean;
	workers?: number;
};
export function tickets(dir: string): Ticket[];
export function ticketKind(content: string): {
	old: boolean;
	full: boolean;
	held: boolean;
	workers: number | undefined;
};
export function mayTry(
	line: { name: string; full: boolean; held: boolean }[],
	slots: number,
): Set<string>;
export function isFullRun(
	cmd: string,
	args: string[],
	opts?: { env?: Record<string, string | undefined>; cwd?: string },
): boolean;
export function markHeld(path: string): void;
export function writeWorkers(path: string, workers: number): void;
export function joinLine(
	dir: string,
	opts?: { full?: boolean },
): {
	name: string;
	path: string;
	place(): number;
	turn(slots: number): { go: boolean; ahead: number };
	leave(): void;
};
