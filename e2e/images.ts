import { crc32, deflateSync } from "node:zlib";

/** Tiny real images for e2e fixtures, made in code (no image files in the repo). */

export type Rgba = readonly [number, number, number, number];

const u32 = (n: number) => {
	const b = Buffer.alloc(4);
	b.writeUInt32BE(n >>> 0);
	return b;
};

function chunk(type: string, data: Buffer): Buffer {
	const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
	return Buffer.concat([u32(data.length), body, u32(crc32(body))]);
}

/**
 * A valid `w`×`h` RGBA PNG. `color(x, y)` gives each pixel; a single color
 * is fine too. PNGs carry NULs, so git calls them binary.
 */
export function png(
	w: number,
	h: number,
	color: Rgba | ((x: number, y: number) => Rgba),
): Uint8Array {
	const at = typeof color === "function" ? color : () => color;
	const raw = Buffer.alloc((w * 4 + 1) * h);
	for (let y = 0; y < h; y++) {
		const row = y * (w * 4 + 1);
		raw[row] = 0; // no filter
		for (let x = 0; x < w; x++) {
			const [r, g, b, a] = at(x, y);
			raw.set([r, g, b, a], row + 1 + x * 4);
		}
	}
	const ihdr = Buffer.concat([
		u32(w),
		u32(h),
		Buffer.from([8, 6, 0, 0, 0]), // 8-bit RGBA, no interlace
	]);
	return new Uint8Array(
		Buffer.concat([
			Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
			chunk("IHDR", ihdr),
			chunk("IDAT", deflateSync(raw)),
			chunk("IEND", Buffer.alloc(0)),
		]),
	);
}

/** A valid `w`×`h` 24-bit BMP of one color (the installer case). */
export function bmp(w: number, h: number, [r, g, b]: Rgba): Uint8Array {
	const stride = Math.ceil((w * 3) / 4) * 4;
	const size = 54 + stride * h;
	const out = Buffer.alloc(size);
	out.write("BM", 0, "latin1");
	out.writeUInt32LE(size, 2);
	out.writeUInt32LE(54, 10);
	out.writeUInt32LE(40, 14);
	out.writeInt32LE(w, 18);
	out.writeInt32LE(h, 22);
	out.writeUInt16LE(1, 26);
	out.writeUInt16LE(24, 28);
	out.writeUInt32LE(stride * h, 34);
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) out.set([b, g, r], 54 + y * stride + x * 3);
	}
	return new Uint8Array(out);
}

export const RED: Rgba = [220, 40, 60, 255];
export const GREEN: Rgba = [40, 200, 120, 255];
export const BLUE: Rgba = [40, 80, 220, 255];
