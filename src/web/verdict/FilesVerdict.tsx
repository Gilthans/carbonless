import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { ReviewThread } from "../../shared/types";
import { overviewQuery, sessionQuery, verdictQuery } from "../api";
import { blockerCount, blockers } from "./blockers";
import { VerdictCard } from "./VerdictCard";

/** How far below the window the end card starts reading GitHub's facts. */
const NEAR = "600px";

/**
 * The verdict card after the last file in Files changed, with a link to
 * the blockers instead of their list. GitHub's merge facts (for "Blockers:
 * N" and the reviewer's verdict's commit) are read only once the card
 * nears the window, never on the page's first open; until then the
 * verdict shown is the overview's.
 */
export function FilesVerdict(props: {
	threads: readonly ReviewThread[] | undefined;
}) {
	const session = useQuery({ ...sessionQuery, enabled: false }).data;
	const overview = useQuery({ ...overviewQuery, enabled: false }).data;
	const box = useRef<HTMLDivElement>(null);
	const [near, setNear] = useState(false);
	useEffect(() => {
		const el = box.current;
		if (near || !el || typeof IntersectionObserver === "undefined") return;
		const observer = new IntersectionObserver(
			(entries) => {
				if (entries.some((e) => e.isIntersecting)) setNear(true);
			},
			{ rootMargin: `0px 0px ${NEAR} 0px` },
		);
		observer.observe(el);
		return () => observer.disconnect();
	}, [near]);
	const facts = useQuery({ ...verdictQuery, enabled: near });
	const count =
		facts.data && overview && session
			? blockerCount(
					blockers(facts.data, overview, props.threads, session.viewer),
				)
			: null;
	return (
		<div ref={box}>
			{overview && session && (
				<VerdictCard
					place="files"
					facts={facts.data}
					overview={overview}
					session={session}
					threads={props.threads}
					blockers={overview.state === "OPEN" ? count : 0}
				/>
			)}
		</div>
	);
}
