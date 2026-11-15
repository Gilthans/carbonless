import { describe, expect, it } from "vitest";
import {
	IMAGE_AUTO_LOAD_BYTES,
	IMAGE_MAX_BYTES,
	IMAGE_TYPES,
	imageTypeOf,
	isImagePath,
	sniffRaster,
} from "./imageTypes";

const bytes = (...values: (number | string)[]) =>
	new Uint8Array(
		values.flatMap((v) =>
			typeof v === "string" ? [...v].map((c) => c.charCodeAt(0)) : [v],
		),
	);

describe("image types", () => {
	it("maps an extension to its type, whatever its case", () => {
		expect(imageTypeOf("a/B.PNG")).toBe("image/png");
		expect(imageTypeOf("x.svg")).toBe("image/svg+xml");
		expect(imageTypeOf("x.jpeg")).toBe("image/jpeg");
		expect(imageTypeOf("x.ico")).toBe("image/x-icon");
		expect(imageTypeOf("x.tiff")).toBeNull();
		expect(imageTypeOf("png")).toBeNull();
		expect(imageTypeOf("dir.png/readme")).toBeNull();
		expect(isImagePath("logo.webp")).toBe(true);
		expect(isImagePath("notes.txt")).toBe(false);
		expect(Object.keys(IMAGE_TYPES).sort()).toEqual(
			["avif", "bmp", "gif", "ico", "jpeg", "jpg", "png", "svg", "webp"].sort(),
		);
	});

	it("has the caps of the spec", () => {
		expect(IMAGE_AUTO_LOAD_BYTES).toBe(10 * 1024 * 1024);
		expect(IMAGE_MAX_BYTES).toBe(50 * 1024 * 1024);
	});

	it("sniffs each raster signature", () => {
		expect(
			sniffRaster(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0)),
		).toBe("image/png");
		expect(sniffRaster(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe("image/jpeg");
		expect(sniffRaster(bytes("GIF87a", 1))).toBe("image/gif");
		expect(sniffRaster(bytes("GIF89a", 1))).toBe("image/gif");
		expect(sniffRaster(bytes("RIFF", 1, 2, 3, 4, "WEBP", "VP8 "))).toBe(
			"image/webp",
		);
		expect(sniffRaster(bytes("BM", 0, 0))).toBe("image/bmp");
		expect(sniffRaster(bytes(0, 0, 1, 0, 1, 0))).toBe("image/x-icon");
	});

	it("never sniffs SVG, HTML or anything else as an image", () => {
		expect(sniffRaster(bytes("<svg xmlns=..."))).toBeNull();
		expect(sniffRaster(bytes("<?xml version"))).toBeNull();
		expect(sniffRaster(bytes("<!DOCTYPE html>"))).toBeNull();
		expect(sniffRaster(bytes("<html>"))).toBeNull();
		expect(sniffRaster(bytes(0x13, 0x37, 0x42, 0x99, 0x01, 0xfe))).toBeNull();
		expect(sniffRaster(bytes("RIFF", 1, 2, 3, 4, "WAVE"))).toBeNull();
		expect(sniffRaster(bytes(0x89, 0x50, 0x4e))).toBeNull();
		expect(sniffRaster(new Uint8Array())).toBeNull();
	});
});
