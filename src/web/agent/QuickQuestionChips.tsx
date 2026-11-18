import { SkeletonBar, Spinner } from "../Spinner";

/**
 * One-tap questions above an Ask agent box (quickQuestions.ts): a tap puts
 * the question in the box (`onPick`), never sends. They wrap on a narrow
 * screen and never truncate (so no tooltip: the text is the label). While
 * it isn't known which questions apply (`questions` null), a spinner and
 * chip-shaped skeletons hold their place, never the wrong list.
 */
export function QuickQuestionChips(props: {
	questions: readonly string[] | null;
	onPick: (question: string) => void;
}) {
	if (props.questions === null) {
		return (
			<div
				data-testid="agent-quick-questions-loading"
				aria-busy="true"
				className="flex min-h-10 flex-wrap items-center gap-1.5"
			>
				<Spinner label="Loading suggested questions" size={14} />
				<SkeletonBar className="h-8 w-40 rounded-full" />
				<SkeletonBar className="h-8 w-56 rounded-full" />
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
						className="flex min-h-10 max-w-full items-center rounded-full border border-agent-edge bg-agent/60 px-3 py-1.5 text-left text-xs leading-snug text-ink-soft break-words hover:border-agent-ink hover:bg-agent hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
					>
						{q}
					</button>
				</li>
			))}
		</ul>
	);
}
