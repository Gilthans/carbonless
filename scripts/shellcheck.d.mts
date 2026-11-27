export const VERSION: string;
export const DOWNLOAD_TIMEOUT_MS: number;
export const HEADER_LINES: number;
export class HashMismatch extends Error {}
export function assetFor(platform: string, arch: string): string | null;
export function isShellShebang(text: string): boolean;
export function shellScripts(root: string, paths: string[]): string[];
export function shellcheckArgs(
	root: string,
	flags: string[],
	files: string[],
): string[];
export function isWorkflow(path: string): boolean;
export function maskExpressions(s: string): string;
export type RunBlock = {
	line: number;
	col: number;
	shell: "sh" | "bash";
	script: string;
};
export function workflowRunBlocks(text: string, file?: string): RunBlock[];
export function windowsJobLines(text: string): Set<number>;
export function blockFile(block: RunBlock): string;
export function remapGcc(
	out: string,
	where: Map<string, RunBlock & { file: string }>,
): string;
export function ensureBinary(
	dir: string,
	options: {
		url: string;
		sha256: string;
		fetch?: (url: string, init: { signal?: AbortSignal }) => Promise<Response>;
		env?: Record<string, string | undefined>;
		log?: (message: string) => void;
	},
): Promise<string | null>;
