export function startTime(pid: number): string;
export function ticketState(
	content: string,
): "live" | "dead" | "stopped" | "foreign";
export function line(dir: string): string[];
export function joinLine(dir: string): {
	name: string;
	place(): number;
	leave(): void;
};
