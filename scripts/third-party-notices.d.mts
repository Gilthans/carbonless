import type { Plugin } from "vite";

export const FILE_NAME: string;
export const LICENSE_CHOICES: Record<string, string>;
export const LICENSE_CUTS: Record<string, { file: string; before: string }>;
export const VIRTUAL_PACKAGES: Record<string, string>;
export function virtualPackageFile(id: string, root: string): string;
export function cssImports(css: string): string[];
export function cssPackageFiles(file: string, seen?: Set<string>): string[];
export const LICENSE_OVERRIDES: Record<
	string,
	{ file: string; source: string }
>;
export type NoticePackage = {
	name: string;
	version: string;
	license: string;
	chosen?: string;
	url?: string;
	texts: { file: string; text: string }[];
};
export function packageRoot(id: string): string | null;
export function collectPackages(
	moduleIds: Iterable<string>,
	options?: {
		choices?: Record<string, string>;
		overrides?: Record<string, { file: string; source: string }>;
		cuts?: Record<string, { file: string; before: string }>;
		overridesDir?: string;
	},
): NoticePackage[];
export function renderNotices(packages: NoticePackage[]): string;
export function thirdPartyNotices(options?: { overridesDir?: string }): Plugin;
