export interface FlakeArgs {
	runs: number;
	load: number;
	grep: string | undefined;
	projects: string[];
	units: string[];
	specs: string[];
}

/** pnpm flake-check's arguments, or why they can't be used. */
export function parseFlakeArgs(
	argv: readonly string[],
): FlakeArgs | { error: string };
