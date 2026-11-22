import { useLayoutEffect, useRef } from "react";
import { SkeletonBar, Spinner } from "../Spinner";

/**
 * One-tap questions above an Ask agent box (quickQuestions.ts): a tap puts
 * the question in the box (`onPick`), never sends. Each chip shows its whole
 * question, wrapping, so a long one can be read before picking it (the
 * owner, 2026-11-18). The list is capped in height and scrolls, starting
 * scrolled all the way down (the owner, 2026-11-22: "Still limit the height
 * of the box, but instead of "Show more", it should have a scroll bar and
 * start scrolled all the way down"). While it isn't known which questions
 * apply (`questions` null), a spinner and chip-shaped skeletons hold their
 * place, never the wrong list.
 */
/** Skeleton chips: three, the drawer's lists' length. */
const SKELETON_WIDTHS = ["w-40", "w-64", "w-56"];

/**
 * The list's cap: two 40px rows and a peek of the third, so it visibly
 * scrolls. The padding keeps a chip's focus ring inside the scroller.
 */
const CAP = "max-h-28 p-0.5";

export function QuickQuestionChips(props: {
	questions: readonly string[] | null;
	onPick: (question: string) => void;
}) {
	const list = useRef<HTMLUListElement>(null);
	// Whether the reader is at the bottom (within 2px), kept on every scroll:
	// a reflow re-pins the list only then, never yanking one who scrolled up.
	const pinned = useRef(true);
	// The questions' content, not the array's identity: a parent's rerender
	// with the same questions never scrolls the reader back down.
	const key = props.questions?.join("\n");
	// Before paint, so the list never shows its top first.
	useLayoutEffect(() => {
		const el = list.current;
		if (!el || key === undefined) return;
		el.scrollTop = el.scrollHeight;
		pinned.current = true;
		// A reflow while shown (a phone's rotation, the drawer's width): the
		// list and its chips change size, and a pinned list stays at its bottom.
		if (typeof ResizeObserver === "undefined") return;
		const ro = new ResizeObserver(() => {
			if (pinned.current) el.scrollTop = el.scrollHeight;
		});
		ro.observe(el);
		for (const li of el.children) ro.observe(li);
		return () => ro.disconnect();
	}, [key]);
	if (props.questions === null) {
		// Capped like the list, so nothing moves when an overflowing list
		// arrives.
		return (
			<div
				data-testid="agent-quick-questions-loading"
				aria-busy="true"
				className={`relative flex flex-col gap-1.5 overflow-hidden ${CAP}`}
			>
				{SKELETON_WIDTHS.map((w) => (
					<div key={w} className="flex min-h-10 shrink-0 items-center">
						<SkeletonBar className={`h-8 ${w} max-w-full rounded-full`} />
					</div>
				))}
				<Spinner
					label="Loading suggested questions"
					size={14}
					className="absolute top-3 right-1"
				/>
			</div>
		);
	}
	return (
		<ul
			ref={list}
			onScroll={(e) => {
				const el = e.currentTarget;
				pinned.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 2;
			}}
			data-testid="agent-quick-questions"
			aria-label="Suggested questions"
			className={`flex min-w-0 flex-wrap gap-1.5 overflow-y-auto overscroll-contain [scrollbar-width:thin] ${CAP}`}
		>
			{props.questions.map((q) => (
				<li
					key={q}
					className="flex min-w-0 max-w-full rounded-[20px] bg-agent/60 text-xs leading-snug text-ink-soft ring-1 ring-agent-edge ring-inset hover:bg-agent hover:ring-agent-ink"
				>
					<button
						type="button"
						data-testid="agent-quick-question"
						onClick={() => props.onPick(q)}
						// The box keeps focus (no phone keyboard bounce), as Ask and Send do.
						onMouseDown={(e) => e.preventDefault()}
						className="flex min-h-10 min-w-0 flex-1 items-center rounded-[20px] px-3 py-1.5 text-left hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
					>
						<span className="min-w-0 break-words">{q}</span>
					</button>
				</li>
			))}
		</ul>
	);
}
