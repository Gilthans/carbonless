import type { Plugin } from "vite";

export function virtualPackageFile(id: string, root: string): string;
export function cssPackageFiles(file: string, seen?: Set<string>): string[];
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
		rowsPerModule?: Record<string, RegExp>;
		overridesDir?: string;
	},
): NoticePackage[];
export function renderNotices(packages: NoticePackage[]): string;
export function thirdPartyNotices(options?: {
	overridesDir?: string;
	required?: string[];
}): Plugin;
export const LICENSES_DIR: string;
