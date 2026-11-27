export const VERSION: string;
export function assetFor(platform: string, arch: string): string | null;
export function isShellShebang(text: string): boolean;
export function shellScripts(root: string, paths: string[]): string[];
export function isWorkflow(path: string): boolean;
export function workflowRunBlocks(
	text: string,
): { line: number; indent: number; script: string }[];
