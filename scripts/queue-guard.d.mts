export function requireQueue(how: string): void;
export function queuedWorkers(
	cores: number,
	freeBytes?: number,
): number | undefined;
export const WORKER_BYTES: number;
export const SHORT_MAX: number;
export function workersFor(machine: {
	cores: number;
	freeBytes: number;
	slots: number;
	full: boolean;
	others: { full: boolean; old?: boolean; workers?: number }[];
}): number;
