import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { ReviewThread } from "../../shared/types";
import { overviewQuery, sessionQuery, verdictQuery } from "../api";
import { blockerCount, blockers } from "./blockers";
import { VerdictCard } from "./VerdictCard";

/**
 * The verdict card after the last file in Files changed, with a link to
 * the blockers instead of their list. GitHub's merge facts (for "Blockers:
 * N" and the reviewer's verdict's commit) are read only once the page's
 * first open has settled (`settled`: its files and threads are in) and the
 * card is on screen, never competing with the first open's reads; until
 * then it says "Blockers" and shows the overview's verdict.
 */
export function FilesVerdict(props: {
	threads: readonly ReviewThread[] | undefined;
	settled: boolean;
}) {
	const session = useQuery({ ...sessionQuery, enabled: false }).data;
	const overview = useQuery({ ...overviewQuery, enabled: false }).data;
	const box = useRef<HTMLDivElement>(null);
	const [near, setNear] = useState(false);
	const { settled } = props;
	useEffect(() => {
		const el = box.current;
		if (
			near ||
			!settled ||
			!el ||
			typeof IntersectionObserver === "undefined"
		) {
			return;
		}
		const observer = new IntersectionObserver((entries) => {
			if (entries.some((e) => e.isIntersecting)) setNear(true);
		});
		observer.observe(el);
		return () => observer.disconnect();
	}, [near, settled]);
	const facts = useQuery({ ...verdictQuery, enabled: near });
	const count =
		facts.data && overview && session
			? blockerCount(
					blockers(facts.data, overview, props.threads, session.viewer),
				)
			: null;
	return (
		<div ref={box} id="files-verdict">
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
