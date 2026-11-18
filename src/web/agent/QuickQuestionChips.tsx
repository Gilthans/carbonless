import { SkeletonBar, Spinner } from "../Spinner";

/**
 * One-tap questions above an Ask agent box (quickQuestions.ts): a tap puts
 * the question in the box (`onPick`), never sends. They wrap on a narrow
 * screen and never truncate (so no tooltip: the text is the label). While
 * it isn't known which questions apply (`questions` null), a spinner and
 * chip-shaped skeletons hold their place, never the wrong list.
 */
/** Skeleton chips: three, the drawer's lists' length. */
const SKELETON_WIDTHS = ["w-40", "w-64", "w-56"];

export function QuickQuestionChips(props: {
	questions: readonly string[] | null;
	onPick: (question: string) => void;
}) {
	if (props.questions === null) {
		// As tall as the list it stands for (a chip per row at most), so
		// nothing moves when it arrives.
		return (
			<div
				data-testid="agent-quick-questions-loading"
				aria-busy="true"
				className="relative flex flex-col gap-1.5"
			>
				{SKELETON_WIDTHS.map((w) => (
					<div key={w} className="flex min-h-10 items-center">
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
			data-testid="agent-quick-questions"
			aria-label="Suggested questions"
			className="flex min-w-0 flex-wrap gap-1.5"
		>
			{props.questions.map((q) => (
				<li key={q} className="min-w-0 max-w-full">
					<button
						type="button"
						data-testid="agent-quick-question"
						onClick={() => props.onPick(q)}
						// The box keeps focus (no phone keyboard bounce), as Ask and Send do.
						onMouseDown={(e) => e.preventDefault()}
						className="flex min-h-10 max-w-full items-center rounded-full border border-agent-edge bg-agent/60 px-3 py-1.5 text-left text-xs leading-snug text-ink-soft break-words hover:border-agent-ink hover:bg-agent hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
					>
						{q}
					</button>
				</li>
			))}
		</ul>
	);
}
