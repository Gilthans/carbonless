import { type SyntheticEvent, useEffect, useRef, useState } from "react";
import {
	IMAGE_AUTO_LOAD_BYTES,
	IMAGE_MAX_BYTES,
} from "../../../../shared/imageTypes";
import type { Size } from "./stage";

/**
 * One side of an image file, as its `<img>` reads it:
 * - `waiting-tap`: over the auto-load cap (or not `auto`); nothing is
 *   requested until `load()`.
 * - `loading`, then `ready` with the image's natural size.
 * - `stale`: the review moved to a new snapshot (the route's 409).
 * - `too-big`: over the route's cap (413, or the known size says so).
 * - `missing`: no such side (no url, or 404: e.g. a file new since the
 *   patch set compared with).
 * - `undecodable`: anything else the browser couldn't show.
 */
export type ImageSideState =
	| "waiting-tap"
	| "loading"
	| "ready"
	| "stale"
	| "too-big"
	| "missing"
	| "undecodable";

export interface ImageSide {
	state: ImageSideState;
	/** The `<img>`'s source: only while loading or ready. */
	src?: string;
	/** The natural size, once ready (0×0 for an SVG with none). */
	size?: Size;
	/** Starts a tap-to-load side. */
	load(): void;
	onLoad(event: SyntheticEvent<HTMLImageElement>): void;
	/**
	 * The `<img>` failed. It can't see the status, so a HEAD of the same
	 * url says why (409 stale, 413 too big, 404 missing, else undecodable).
	 */
	onError(): void;
}

function initial(
	url: string | null,
	bytes: number | undefined,
	auto: boolean,
): ImageSideState {
	if (url === null) return "missing";
	if (bytes !== undefined && bytes > IMAGE_MAX_BYTES) return "too-big";
	if (!auto) return "waiting-tap";
	if (bytes !== undefined && bytes > IMAGE_AUTO_LOAD_BYTES)
		return "waiting-tap";
	return "loading";
}

const byStatus = (status: number): ImageSideState =>
	status === 409
		? "stale"
		: status === 413
			? "too-big"
			: status === 404
				? "missing"
				: "undecodable";

/** A length in user units or px: an intrinsic size (not a percentage or em). */
const ABSOLUTE = /^\s*\d*\.?\d+\s*(px)?\s*$/;

/**
 * Whether the SVG at `url` sets its own width and height (absolute), so
 * the browser's natural size is its own. Parsed with DOMParser, an inert
 * document: nothing in it runs or loads. Unknown (a failed read) is null.
 */
async function svgSized(url: string): Promise<boolean | null> {
	try {
		const response = await fetch(url);
		if (!response.ok) return null;
		const doc = new DOMParser().parseFromString(
			await response.text(),
			"image/svg+xml",
		);
		const root = doc.documentElement;
		if (root.localName !== "svg") return null;
		return ["width", "height"].every((name) =>
			ABSOLUTE.test(root.getAttribute(name) ?? ""),
		);
	} catch {
		return null;
	}
}

/**
 * See ImageSide. `bytes` is the side's blob size, when known; `svg`: an
 * SVG, whose missing size reads as 0×0 (stage.ts).
 */
export function useImageSide(
	url: string | null,
	bytes: number | undefined,
	auto: boolean,
	opts: { svg?: boolean } = {},
): ImageSide {
	const [shown, setShown] = useState<{
		url: string | null;
		state: ImageSideState;
		size?: Size;
	}>(() => ({ url, state: initial(url, bytes, auto) }));
	// A new url (a new revision) starts over.
	const current =
		shown.url === url ? shown : { url, state: initial(url, bytes, auto) };
	if (current !== shown) setShown(current);
	// The url a probe's answer must still be for.
	const live = useRef(url);
	live.current = url;
	const mounted = useRef(true);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);

	const settle = (state: ImageSideState, size?: Size) =>
		setShown((s) => (s.url === url ? { url, state, size } : s));

	return {
		state: current.state,
		...(url !== null &&
		(current.state === "loading" || current.state === "ready")
			? { src: url }
			: {}),
		...(current.size ? { size: current.size } : {}),
		load: () => {
			if (current.state === "waiting-tap") settle("loading");
		},
		onLoad: (event) => {
			const img = event.currentTarget;
			const natural = { w: img.naturalWidth, h: img.naturalHeight };
			if (!opts.svg || url === null) {
				settle("ready", natural);
				return;
			}
			// A browser gives an SVG with no size a default one (Chrome:
			// 300×150): read its root (cached) to tell.
			const read = url;
			svgSized(read).then((sized) => {
				if (mounted.current && live.current === read) {
					settle("ready", sized === false ? { w: 0, h: 0 } : natural);
				}
			});
		},
		onError: () => {
			if (url === null) return;
			const probed = url;
			fetch(probed, { method: "HEAD" }).then(
				(response) => {
					if (mounted.current && live.current === probed) {
						settle(byStatus(response.status));
					}
				},
				() => {
					if (mounted.current && live.current === probed) settle("undecodable");
				},
			);
		},
	};
}
