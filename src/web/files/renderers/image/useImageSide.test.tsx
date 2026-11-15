// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { heldJson } from "../../../../../test/loading";
import {
	IMAGE_AUTO_LOAD_BYTES,
	IMAGE_MAX_BYTES,
} from "../../../../shared/imageTypes";
import { useImageSide } from "./useImageSide";

const URL_A = "/api/r/x/files/0/blob?revision=r1&side=new";
const URL_B = "/api/r/x/files/0/blob?revision=r2&side=new";

/** An <img>'s load event, as React hands it to onLoad. */
const loaded = (w: number, h: number) =>
	({
		currentTarget: { naturalWidth: w, naturalHeight: h },
	}) as unknown as React.SyntheticEvent<HTMLImageElement>;

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
	fetchMock = vi.fn();
	vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("useImageSide", () => {
	it("loads at once under the cap, and is ready with the image's size", () => {
		const { result } = renderHook(() => useImageSide(URL_A, 1000, true));
		expect(result.current.state).toBe("loading");
		expect(result.current.src).toBe(URL_A);
		act(() => result.current.onLoad(loaded(493, 312)));
		expect(result.current.state).toBe("ready");
		expect(result.current.size).toEqual({ w: 493, h: 312 });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("an error then HEAD 409 is stale; while the probe is held it stays loading", async () => {
		const held = heldJson();
		fetchMock.mockReturnValue(held.response);
		const { result } = renderHook(() => useImageSide(URL_A, 1000, true));
		act(() => result.current.onError());
		expect(fetchMock).toHaveBeenCalledWith(URL_A, { method: "HEAD" });
		expect(result.current.state).toBe("loading");
		held.release({}, 409);
		await waitFor(() => expect(result.current.state).toBe("stale"));
	});

	it.each([
		[200, "undecodable"],
		[415, "undecodable"],
		[500, "undecodable"],
		[413, "too-big"],
		[404, "missing"],
	] as const)("an error then HEAD %d is %s", async (status, state) => {
		fetchMock.mockResolvedValue(new Response(null, { status }));
		const { result } = renderHook(() => useImageSide(URL_A, 1000, true));
		act(() => result.current.onError());
		await waitFor(() => expect(result.current.state).toBe(state));
		expect(result.current.src).toBeUndefined();
	});

	it("a probe that can't reach the server is undecodable", async () => {
		fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
		const { result } = renderHook(() => useImageSide(URL_A, 1000, true));
		act(() => result.current.onError());
		await waitFor(() => expect(result.current.state).toBe("undecodable"));
	});

	it("over 10 MB waits for a tap: no source and no request until load()", () => {
		const { result } = renderHook(() =>
			useImageSide(URL_A, IMAGE_AUTO_LOAD_BYTES + 1, true),
		);
		expect(result.current.state).toBe("waiting-tap");
		expect(result.current.src).toBeUndefined();
		expect(fetchMock).not.toHaveBeenCalled();
		act(() => result.current.load());
		expect(result.current.state).toBe("loading");
		expect(result.current.src).toBe(URL_A);
	});

	it("exactly 10 MB loads on its own", () => {
		const { result } = renderHook(() =>
			useImageSide(URL_A, IMAGE_AUTO_LOAD_BYTES, true),
		);
		expect(result.current.state).toBe("loading");
	});

	it("not auto: waits for a tap whatever the size", () => {
		const { result } = renderHook(() => useImageSide(URL_A, 10, false));
		expect(result.current.state).toBe("waiting-tap");
	});

	it("over the route's cap is too big at once, with nothing to tap", () => {
		const { result } = renderHook(() =>
			useImageSide(URL_A, IMAGE_MAX_BYTES + 1, true),
		);
		expect(result.current.state).toBe("too-big");
		expect(result.current.src).toBeUndefined();
	});

	it("no url (no such side) is missing", () => {
		const { result } = renderHook(() => useImageSide(null, undefined, true));
		expect(result.current.state).toBe("missing");
		expect(result.current.src).toBeUndefined();
	});

	it("a new url starts over, and an old probe's answer is ignored", async () => {
		const held = heldJson();
		fetchMock.mockReturnValue(held.response);
		const { result, rerender } = renderHook(
			({ url }) => useImageSide(url, 1000, true),
			{ initialProps: { url: URL_A } },
		);
		act(() => result.current.onError());
		rerender({ url: URL_B });
		expect(result.current.state).toBe("loading");
		expect(result.current.src).toBe(URL_B);
		held.release({}, 409);
		// The probe of URL_A settles; URL_B keeps loading.
		await act(async () => {
			await held.response;
		});
		expect(result.current.state).toBe("loading");
		act(() => result.current.onLoad(loaded(10, 20)));
		expect(result.current.state).toBe("ready");
	});

	describe("an SVG", () => {
		const svgAnswer = (text: string) =>
			new Response(text, {
				status: 200,
				headers: { "content-type": "image/svg+xml" },
			});

		it("with no width or height has no intrinsic size (0×0), whatever the browser's default", async () => {
			fetchMock.mockResolvedValue(
				svgAnswer('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>'),
			);
			const { result } = renderHook(() =>
				useImageSide(URL_A, 100, true, { svg: true }),
			);
			// Chrome reports 300×150 for it.
			act(() => result.current.onLoad(loaded(300, 150)));
			expect(result.current.state).toBe("loading");
			await waitFor(() => expect(result.current.state).toBe("ready"));
			expect(result.current.size).toEqual({ w: 0, h: 0 });
			expect(fetchMock).toHaveBeenCalledWith(URL_A);
		});

		it.each([
			['width="100%" height="50"', { w: 0, h: 0 }],
			['viewBox="0 0 40 30"', { w: 0, h: 0 }],
			['width="40" height="30"', { w: 300, h: 150 }],
			['width="40px" height="30px" viewBox="0 0 4 3"', { w: 300, h: 150 }],
		])("%s", async (attrs, size) => {
			fetchMock.mockResolvedValue(
				svgAnswer(`<svg xmlns="http://www.w3.org/2000/svg" ${attrs}/>`),
			);
			const { result } = renderHook(() =>
				useImageSide(URL_A, 100, true, { svg: true }),
			);
			act(() => result.current.onLoad(loaded(300, 150)));
			await waitFor(() => expect(result.current.state).toBe("ready"));
			expect(result.current.size).toEqual(size);
		});

		it("that can't be read again keeps the browser's size", async () => {
			fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
			const { result } = renderHook(() =>
				useImageSide(URL_A, 100, true, { svg: true }),
			);
			act(() => result.current.onLoad(loaded(40, 30)));
			await waitFor(() => expect(result.current.state).toBe("ready"));
			expect(result.current.size).toEqual({ w: 40, h: 30 });
		});
	});
});
