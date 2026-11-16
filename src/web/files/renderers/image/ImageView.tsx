import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import { imageTypeOf, isImagePath } from "../../../../shared/imageTypes";
import type { FileView } from "../../../../shared/types";
import { blobUrl } from "../../../api";
import { imageMode } from "../../../viewSettings";
import { reloadStale, STALE_MESSAGE } from "../../useSetStates";
import { ImageCompare } from "./ImageCompare";
import { dimsText, ImageSingle, Stage, type Tone } from "./ImageSingle";
import { type DimsSide, ImageToolbar } from "./ImageToolbar";
import { bytesPair, formatBytes } from "./stage";
import { type ImageSide, useImageSide } from "./useImageSide";

/**
 * Whether two blob urls name the same blob: their ETags are the blob oids
 * (the route's HEAD reads no bytes). For a renamed file, whose two sides
 * the snapshot doesn't compare for us (git calls an unchanged binary's
 * rename binary too). Any failure answers false: both sides show, and
 * their own loads say why.
 */
async function sameBlob(oldUrl: string, newUrl: string): Promise<boolean> {
	try {
		const [a, b] = await Promise.all(
			[oldUrl, newUrl].map((url) => fetch(url, { method: "HEAD" })),
		);
		const tag = a?.headers.get("etag");
		return Boolean(a?.ok && b?.ok && tag && tag === b.headers.get("etag"));
	} catch {
		return false;
	}
}

/**
 * The image renderer's view (spec "Unified view", "Side-by-side view",
 * "Edge cases"), above `DiffBody linesHidden`, which keeps the file's
 * review rows and threads. It shows; it never writes a review state.
 *
 * - Two versions: one stage with a slider or a fade (unified), or two
 *   single views (side-by-side; stacked on a phone).
 * - One version (added, deleted, renamed unchanged): a single view, with an
 *   "added"/"deleted" label and edge.
 * - Not decodable or too big: no stage; the binary rows below stand, and
 *   the toolbar keeps the byte sizes.
 * - Stale (the route's 409): the review is read again, as for a refused
 *   write; the new revision loads the image anew.
 * - Over the auto-load cap: a button loads it.
 */
export function ImageView(props: {
	file: FileView;
	revision: string;
	/** The since view's patch set: its interdiff's sides. */
	from?: number;
	sideBySide: boolean;
	/**
	 * The view switch for the toolbar (FileDiff): `modes` when two versions
	 * share one stage, so Slider and Fade apply.
	 */
	view?: (modes: boolean) => ReactNode;
}) {
	const { file, revision, from } = props;
	const view = (modes: boolean) => props.view?.(modes);
	// An extension crb doesn't know, shown as Image: the server checks the bytes.
	const sniff = !isImagePath(file.path);
	// An SVG with no width or height has no size of its own (stage.ts).
	const svg = imageTypeOf(file.path) === "image/svg+xml";
	// Only the since view may lack a side its status names (a 404 says so).
	const mayBeAbsent = from !== undefined;
	// The since view's old side is the interdiff's: it may exist for a file
	// the PR added (a 404 says it doesn't).
	const oldUrl =
		from !== undefined || file.status !== "added"
			? blobUrl(revision, file.index, "old", from, sniff)
			: null;
	const newUrl =
		file.status !== "deleted"
			? blobUrl(revision, file.index, "new", from, sniff)
			: null;
	// Renamed with no content change: the image shows once.
	const renamed =
		file.status === "renamed" && oldUrl !== null && newUrl !== null;
	const same = useQuery({
		queryKey: ["image-same-blob", oldUrl, newUrl],
		queryFn: () => sameBlob(oldUrl as string, newUrl as string),
		enabled: renamed,
		staleTime: Number.POSITIVE_INFINITY,
	});
	const deciding = renamed && same.isPending;
	const once = renamed && same.data === true;
	// The full diff's old size isn't the interdiff's old side's.
	const oldBytes = from === undefined ? file.oldSize : undefined;
	const before = useImageSide(
		once || deciding ? null : oldUrl,
		oldBytes,
		true,
		{ svg, mayBeAbsent },
	);
	const after = useImageSide(deciding ? null : newUrl, file.newSize, true, {
		svg,
		mayBeAbsent,
	});
	const mode = imageMode.use();
	const [actual, setActual] = useState(false);

	const stale = before.state === "stale" || after.state === "stale";
	const queryClient = useQueryClient();
	useEffect(() => {
		if (stale) reloadStale(queryClient);
	}, [stale, queryClient]);

	const present = [before, after].filter((s) => s.state !== "missing");
	const failed = present.find(
		(s) => s.state === "undecodable" || s.state === "too-big",
	);
	const waiting = present.filter((s) => s.state === "waiting-tap");
	const shownBefore = before.state !== "missing" ? before : null;
	const shownAfter = after.state !== "missing" ? after : null;
	const bytes = bytesPair(
		shownBefore ? oldBytes : undefined,
		shownAfter ? file.newSize : undefined,
	);

	const dims: DimsSide[] = [];
	if (shownBefore) dims.push({ tone: "del", size: sizeOf(shownBefore) });
	if (shownAfter) dims.push({ tone: "add", size: sizeOf(shownAfter) });

	if (stale) {
		return (
			<div className="border-line border-b p-3">
				<p
					role="status"
					className="rounded-md border border-warn/30 bg-warn/10 px-3 py-2 text-ink text-sm"
				>
					{STALE_MESSAGE}
				</p>
			</div>
		);
	}

	if (deciding) {
		// Whether a renamed image changed: loading, as any image is.
		return (
			<div
				data-testid="image-view"
				data-image-state="loading"
				className="@container border-line border-b"
			>
				<ImageToolbar
					view={view(false)}
					dims={[{ tone: "add", size: undefined }]}
					bytes={bytesPair(oldBytes, file.newSize)}
				/>
				<div className="grid min-w-0 justify-items-center gap-2 p-3">
					<Stage geometry={null} actual={false}>
						{null}
					</Stage>
				</div>
			</div>
		);
	}

	if (failed || present.length === 0) {
		return (
			<div data-testid="image-view" data-image-state="fallback">
				<ImageToolbar
					view={view(false)}
					dims={[]}
					bytes={bytesPair(oldBytes, file.newSize)}
					failed={
						failed?.state === "too-big"
							? "Too big to show as an image"
							: "Can't show this as an image"
					}
				/>
			</div>
		);
	}

	if (waiting.length > 0) {
		const total =
			(before.state === "waiting-tap" ? (oldBytes ?? 0) : 0) +
			(after.state === "waiting-tap" ? (file.newSize ?? 0) : 0);
		return (
			<div data-testid="image-view" data-image-state="waiting-tap">
				<ImageToolbar view={view(false)} dims={[]} bytes={bytes} />
				<div className="flex justify-center p-3">
					<button
						type="button"
						onClick={() => {
							before.load();
							after.load();
						}}
						className="min-h-10 rounded-md border border-line-strong px-3 text-ink text-sm hover:bg-overlay focus-visible:outline-2 focus-visible:outline-accent"
					>
						Load image ({formatBytes(total)})
					</button>
				</div>
			</div>
		);
	}

	const compare = shownBefore !== null && shownAfter !== null;
	const single = shownAfter ?? shownBefore;
	const singleTone: Tone | undefined = once
		? undefined
		: shownAfter
			? "add"
			: "del";
	return (
		<div
			data-testid="image-view"
			data-image-state={compare ? "compare" : "single"}
			className="@container border-line border-b"
		>
			<ImageToolbar
				view={view(compare && !props.sideBySide)}
				dims={once ? dims.filter((d) => d.tone === "add") : dims}
				bytes={once ? bytesPair(undefined, file.newSize) : bytes}
				actual={actual}
				onActual={setActual}
			/>
			<div className="grid min-w-0 justify-items-center gap-2 p-3">
				{compare && !props.sideBySide && (
					<ImageCompare
						before={shownBefore}
						after={shownAfter}
						mode={mode}
						actual={actual}
					/>
				)}
				{compare && props.sideBySide && (
					<div
						data-testid="image-side-by-side"
						className="grid w-full min-w-0 grid-cols-1 gap-3 @lg:grid-cols-2"
					>
						<ImageSingle
							side={shownBefore}
							alt="Before"
							tone="del"
							caption={caption("before", shownBefore, oldBytes)}
							actual={actual}
						/>
						<ImageSingle
							side={shownAfter}
							alt="After"
							tone="add"
							caption={caption("after", shownAfter, file.newSize)}
							actual={actual}
						/>
					</div>
				)}
				{!compare && single && (
					<div className="grid w-full min-w-0">
						<ImageSingle
							side={single}
							alt={
								singleTone === "add"
									? "Added image"
									: singleTone === "del"
										? "Deleted image"
										: "Image"
							}
							{...(singleTone
								? {
										tone: singleTone,
										label: singleTone === "add" ? "added" : "deleted",
									}
								: {})}
							actual={actual}
						/>
					</div>
				)}
			</div>
		</div>
	);
}

/** A side's size for the toolbar: undefined until it's ready. */
const sizeOf = (side: ImageSide) =>
	side.state === "ready" ? (side.size ?? { w: 0, h: 0 }) : undefined;

function caption(name: string, side: ImageSide, bytes: number | undefined) {
	const parts = [
		dimsText(side.state === "ready" ? side.size : undefined),
		bytes === undefined ? "" : formatBytes(bytes),
	].filter(Boolean);
	return { name, text: parts.join(" · ") };
}
