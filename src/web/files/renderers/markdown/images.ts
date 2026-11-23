import { isImagePath } from "../../../../shared/imageTypes";
import type { FileSummary } from "../../../../shared/types";
import { blobUrl } from "../../../api";

/** What the view reads of the review's files to load an image from. */
export type ImageFile = Pick<
	FileSummary,
	"index" | "path" | "status" | "binary" | "lfs" | "submodule"
>;

/**
 * A relative image src (as `localSrc` hands it over: decoded, maybe with
 * `..`, `?`, `#` or control characters, all of it a path) resolved against
 * the directory of the Markdown file at `mdPath`, as a repo path; null when
 * it climbs above the repo root. A leading `/` is the repo's root, as on
 * GitHub. Only ever compared with the review's paths: never part of a URL.
 */
export function repoPathOf(src: string, mdPath: string): string | null {
	const dir = mdPath.split("/").slice(0, -1);
	const parts = src.startsWith("/") ? [] : dir;
	const out: string[] = [...parts];
	for (const seg of src.split("/")) {
		if (seg === "" || seg === ".") continue;
		if (seg === "..") {
			if (out.length === 0) return null;
			out.pop();
			continue;
		}
		out.push(seg);
	}
	return out.length ? out.join("/") : null;
}

/**
 * The image resolver for one side of a Markdown file (renderBlocks'
 * `image`): a relative src that names one of the review's changed image
 * files loads that file's side through the blob route, by its index (the
 * route never reads a path); anything else (not in the review, not an
 * image, above the repo root, a side the file doesn't have) gets null, the
 * placeholder, and loads nothing.
 */
export function imageResolver(opts: {
	mdPath: string;
	files: readonly ImageFile[];
	revision: string;
	side: "old" | "new";
	/** The since view's compared patch set (blobUrl's `from`). */
	from?: number;
}): (src: string) => string | null {
	const byPath = new Map(opts.files.map((f) => [f.path, f]));
	return (src) => {
		const path = repoPathOf(src, opts.mdPath);
		if (path === null) return null;
		const file = byPath.get(path);
		if (!file || !isImagePath(file.path) || file.lfs || file.submodule) {
			return null;
		}
		if (opts.side === "old" && file.status === "added") return null;
		if (opts.side === "new" && file.status === "deleted") return null;
		return blobUrl(opts.revision, file.index, opts.side, opts.from);
	};
}

/**
 * A remote image placeholder's URL, when a click may load it: http(s)
 * only, parsed as the browser would; null for anything else
 * (`javascript:`, `data:`, a relative or broken one).
 */
export function remoteImageUrl(raw: string | null): string | null {
	if (!raw) return null;
	try {
		const url = new URL(raw);
		return url.protocol === "http:" || url.protocol === "https:"
			? url.href
			: null;
	} catch {
		return null;
	}
}
