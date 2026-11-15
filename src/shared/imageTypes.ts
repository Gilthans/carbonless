/**
 * Images crb can show as images: the fixed extension table (the only source
 * of an image's type, except for an explicit "Show as Image" on an unknown
 * extension, which sniffs raster signatures) and the size caps.
 */

/** Extension (lowercase, no dot) → MIME type. */
export const IMAGE_TYPES: Readonly<Record<string, string>> = Object.freeze({
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	avif: "image/avif",
	bmp: "image/bmp",
	ico: "image/x-icon",
	svg: "image/svg+xml",
});

/** Images up to this size load on their own; larger ones on a tap. */
export const IMAGE_AUTO_LOAD_BYTES = 10 * 1024 * 1024;

/** The blob route refuses images above this size (the file shows as binary). */
export const IMAGE_MAX_BYTES = 50 * 1024 * 1024;

/** The image type of `path` from its extension, or null. */
export function imageTypeOf(path: string): string | null {
	const name = path.slice(path.lastIndexOf("/") + 1);
	const dot = name.lastIndexOf(".");
	if (dot <= 0) return null;
	const ext = name.slice(dot + 1).toLowerCase();
	return Object.hasOwn(IMAGE_TYPES, ext) ? (IMAGE_TYPES[ext] ?? null) : null;
}

export function isImagePath(path: string): boolean {
	return imageTypeOf(path) !== null;
}

/** Leading bytes of each raster type; null is any byte. */
const SIGNATURES: readonly [string, readonly (number | null)[]][] = [
	["image/png", [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
	["image/jpeg", [0xff, 0xd8, 0xff]],
	["image/gif", [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]],
	["image/gif", [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]],
	[
		"image/webp",
		[0x52, 0x49, 0x46, 0x46, null, null, null, null, 0x57, 0x45, 0x42, 0x50],
	],
	// "BM" plus the rest of the 14-byte file header: two bytes alone are
	// too common a start for text.
	["image/bmp", [0x42, 0x4d, ...new Array<null>(12).fill(null)]],
	["image/x-icon", [0x00, 0x00, 0x01, 0x00]],
];

/**
 * The raster type `head` (a file's leading bytes) starts with: PNG, JPEG,
 * GIF, WebP, BMP or ICO. Never SVG or HTML: anything else is null.
 */
export function sniffRaster(head: Uint8Array): string | null {
	for (const [type, signature] of SIGNATURES) {
		if (
			head.length >= signature.length &&
			signature.every((b, i) => b === null || head[i] === b)
		) {
			return type;
		}
	}
	return null;
}
