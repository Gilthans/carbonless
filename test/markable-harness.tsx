import { useState } from "react";
import {
	crossOffChange,
	sinceToggleChange,
	toggleChange,
} from "../src/shared/pieces";
import { reviewProgress } from "../src/shared/progress";
import type {
	ClusterView,
	FileView,
	ReviewView,
	StateChange,
} from "../src/shared/types";
import { DiffBody } from "../src/web/files/DiffBody";
import type { KindEntry } from "../src/web/files/since";
import { overlayReview, type PendingChange } from "../src/web/files/stateSync";

/*
 * A file's diff with its review state kept the way the page keeps it
 * (FileDiff's changes: toggleChange, crossOffChange, sinceToggleChange;
 * stateSync's overlayReview over the served view), for the markable
 * invariant's component tests (test/markable.ts). `store` is what a
 * remount reads, as a reload reads the stored marks.
 */

export const REVISION = "r";

/** The marks made so far, by key, as the page's pending changes are. */
export type MarkStore = Map<string, PendingChange>;

export function fileView(path: string, clusters: ClusterView[]): FileView {
	return {
		index: 0,
		path,
		status: "modified",
		binary: false,
		submodule: false,
		additions: 1,
		deletions: 1,
		clusters,
		done: clusters.every((c) => c.state !== "unreviewed"),
		reviewed: clusters.every((c) => c.state === "reviewed"),
		crossedOff: false,
	};
}

export function MarkableDiff(props: {
	path: string;
	clusters: ClusterView[];
	store: MarkStore;
	/** The since view from this patch set, with the engine's kinds. */
	from?: number;
	kinds?: Map<string, KindEntry>;
	readOnly?: boolean;
}) {
	const [, bump] = useState(0);
	const files = [fileView(props.path, props.clusters)];
	const served: ReviewView = {
		revision: REVISION,
		patchset: 2,
		files,
		progress: reviewProgress(files),
		sinceMarks: [],
	};
	const view = overlayReview(served, props.store);
	const file = view.files[0] as FileView;
	const save = (change: StateChange) => {
		props.store.set(change.key, {
			change,
			revision: REVISION,
			path: props.path,
			version: props.store.size + 1,
			since: 0,
		});
		bump((n) => n + 1);
	};
	return (
		<DiffBody
			file={file}
			revision={REVISION}
			from={props.from}
			kinds={props.kinds}
			readOnly={props.readOnly}
			sinceMarks={view.sinceMarks}
			onToggle={(c, piece) => save(toggleChange(c, piece))}
			onCrossOff={(c, piece) => save(crossOffChange(c, piece))}
			onSinceMark={(piece, cross) =>
				props.from !== undefined &&
				save(
					sinceToggleChange(
						view.sinceMarks,
						props.from,
						props.path,
						piece,
						cross,
					),
				)
			}
		/>
	);
}
