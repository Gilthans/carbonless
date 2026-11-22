export function startTime(pid: number): string;
export function ticketState(
	content: string,
): "live" | "dead" | "stopped" | "foreign";
export function line(dir: string): string[];
export type Ticket = { name: string; full: boolean; held: boolean };
export function tickets(dir: string): Ticket[];
export function ticketKind(content: string): { full: boolean; held: boolean };
export function mayTry(line: Ticket[], slots: number): Set<string>;
export function sharing(dir: string): number;
export function isFullRun(cmd: string, args: string[]): boolean;
export function markHeld(path: string): void;
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
