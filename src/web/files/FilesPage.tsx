import { useQuery } from "@tanstack/react-query";
import { type RefObject, useEffect, useRef, useState } from "react";
import { reviewQuery } from "../api";
import { ErrorMessage } from "../ui";
import { FileDiff } from "./FileDiff";
import { FileTree } from "./FileTree";
import { ProgressBar } from "./ProgressBar";
import { STALE_MESSAGE } from "./useSetStates";

/**
 * Tracks the file in view: the first file section crossing the band just
 * below the sticky progress bar.
 */
function useCurrentFile(
	container: RefObject<HTMLElement | null>,
	sections: string,
) {
	const [current, setCurrent] = useState<number | null>(null);
	// `sections` changes when the rendered file sections do: observe the new ones.
	// biome-ignore lint/correctness/useExhaustiveDependencies: see above.
	useEffect(() => {
		const root = container.current;
		if (!root || typeof IntersectionObserver === "undefined") return;
		const visible = new Set<number>();
		const observer = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					const index = Number((entry.target as HTMLElement).dataset.fileIndex);
					if (entry.isIntersecting) visible.add(index);
					else visible.delete(index);
				}
				if (visible.size > 0) setCurrent(Math.min(...visible));
			},
			{ rootMargin: "-120px 0px -60% 0px" },
		);
		for (const section of root.querySelectorAll("[data-file-index]")) {
			observer.observe(section);
		}
		return () => observer.disconnect();
	}, [container, sections]);
	return [current, setCurrent] as const;
}

export function FilesPage() {
	const review = useQuery(reviewQuery);
	const [stale, setStale] = useState(false);
	const diffs = useRef<HTMLDivElement>(null);
	const data = review.data;
	const [current, setCurrent] = useCurrentFile(
		diffs,
		data ? `${data.revision}:${data.files.length}` : "",
	);

	const select = (index: number) => {
		setCurrent(index);
		document
			.getElementById(`file-${index}`)
			?.scrollIntoView?.({ block: "start" });
	};

	return (
		<section aria-label="Files changed">
			<h2 className="sr-only">Files changed</h2>
			{review.isPending && <p className="text-slate-500">Loading the diff…</p>}
			{review.isError && <ErrorMessage error={review.error} />}
			{data && (
				<>
					<ProgressBar progress={data.progress} />
					{stale && (
						<p
							role="status"
							className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900"
						>
							{STALE_MESSAGE}
						</p>
					)}
					{data.files.length === 0 ? (
						<p className="mt-4 text-slate-600">This PR changes no files.</p>
					) : (
						<div className="mt-4 flex flex-col gap-4 md:flex-row">
							<aside className="md:sticky md:top-28 md:max-h-[calc(100vh-8rem)] md:w-72 md:shrink-0 md:self-start md:overflow-y-auto">
								<FileTree
									files={data.files}
									current={current}
									onSelect={select}
								/>
							</aside>
							<div ref={diffs} className="min-w-0 flex-1 space-y-3">
								{data.files.map((file) => (
									<FileDiff
										// A new snapshot can reuse an index for another file.
										key={`${data.revision}:${file.index}`}
										file={file}
										revision={data.revision}
										onStale={() => setStale(true)}
									/>
								))}
							</div>
						</div>
					)}
				</>
			)}
		</section>
	);
}
