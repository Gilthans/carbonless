export function requireQueue(how: string): void;
export function queuedWorkers(
	cores: number,
	freeBytes?: number,
): number | undefined;
export const WORKER_BYTES: number;
export function workersFor(machine: {
	cores: number;
	sharing: number;
	freeBytes: number;
}): number;
