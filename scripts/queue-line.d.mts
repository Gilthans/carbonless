export function startTime(pid: number): string;
export function alive(content: string): boolean;
export function line(dir: string): string[];
export function joinLine(dir: string): {
	name: string;
	place(): number;
	leave(): void;
};
