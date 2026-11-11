export type ParsedVersion = {
	major: number;
	minor: number;
	patch: number;
	rc?: number;
};
export function parse(text: string | undefined | null): ParsedVersion | null;
export function compare(a: ParsedVersion, b: ParsedVersion): number;
export function rcMoveTo(
	distTags: Record<string, string> | null | undefined,
	published?: string,
): string | null;
