import { ChevronDownIcon, ChevronUpIcon } from "@primer/octicons-react";
import { useId, useLayoutEffect, useRef, useState } from "react";
import { SkeletonBar, Spinner } from "../Spinner";
import { Tooltip } from "../Tooltip";

/**
 * One-tap questions above an Ask agent box (quickQuestions.ts): a tap puts
 * the question in the box (`onPick`), never sends. A question too long for
 * one line shows one line with an ellipsis and a chevron (Show more) that
 * unfolds it, without picking it (the owner, 2026-11-18: "You don't have to
 * click it to select the prompt, but you should be able to, to see what it
 * is exactly before picking"). The chip's name is the whole question,
 * truncated or not. While it isn't known which questions apply
 * (`questions` null), a spinner and chip-shaped skeletons hold their
 * place, never the wrong list.
 */
/** Skeleton chips: three, the drawer's lists' length. */
const SKELETON_WIDTHS = ["w-40", "w-64", "w-56"];

export function QuickQuestionChips(props: {
	questions: readonly string[] | null;
	onPick: (question: string) => void;
}) {
	if (props.questions === null) {
		// As tall as the list it stands for (a one-line chip per row at
		// most, 40px: the chip's edge is a ring, no border), so nothing
		// moves when it arrives.
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
				<QuestionChip key={q} question={q} onPick={props.onPick} />
			))}
		</ul>
	);
}

/**
 * What the chevron takes from the text while it shows: its 40px less the
 * 12px end padding the text gives up for it.
 */
const CHEVRON_ROOM = 28;

/**
 * Whether `el`'s one line cuts its text off, measured as if the chevron
 * weren't there (`withChevron`: it is, so its room counts as free), so a
 * chip that fits once unfolded and resized never stays cut. A pixel's
 * rounding is no cut. Tests stand in for the widths: jsdom has no layout.
 */
function overflows(el: HTMLElement, withChevron: boolean): boolean {
	const free = el.clientWidth + (withChevron ? CHEVRON_ROOM : 0);
	return el.scrollWidth - free > 1;
}

function QuestionChip(props: {
	question: string;
	onPick: (question: string) => void;
}) {
	const text = useRef<HTMLSpanElement>(null);
	const textId = useId();
	const [cut, setCut] = useState(false);
	const cutNow = useRef(false);
	const [expanded, setExpanded] = useState(false);
	// Measured on one line only (unfolded, it wraps and never overflows), on
	// every resize: a chip can be cut on a phone and fit on a desktop.
	useLayoutEffect(() => {
		const el = text.current;
		if (!el || expanded) return;
		const measure = () => {
			cutNow.current = overflows(el, cutNow.current);
			setCut(cutNow.current);
		};
		measure();
		if (typeof ResizeObserver === "undefined") return;
		const ro = new ResizeObserver(measure);
		ro.observe(el);
		return () => ro.disconnect();
	}, [expanded]);
	const label = expanded ? "Show less" : "Show more";
	return (
		<li
			className={`flex min-w-0 max-w-full items-start rounded-[20px] bg-agent/60 text-xs leading-snug text-ink-soft ring-1 ring-agent-edge ring-inset hover:bg-agent hover:ring-agent-ink ${expanded ? "" : "min-h-10"}`}
		>
			<button
				type="button"
				data-testid="agent-quick-question"
				onClick={() => props.onPick(props.question)}
				// The box keeps focus (no phone keyboard bounce), as Ask and Send do.
				onMouseDown={(e) => e.preventDefault()}
				className={`flex min-h-10 min-w-0 flex-1 items-center rounded-[20px] py-1.5 pl-3 text-left hover:text-ink focus-visible:outline-2 focus-visible:outline-accent ${cut || expanded ? "pr-0" : "pr-3"}`}
			>
				<span
					ref={text}
					id={textId}
					data-testid="agent-quick-question-text"
					className={`min-w-0 ${expanded ? "break-words" : "truncate"}`}
				>
					{props.question}
				</span>
			</button>
			{(cut || expanded) && (
				<Tooltip content={label} describe={false} dismissKey={expanded}>
					{(trigger) => (
						<button
							type="button"
							{...trigger}
							data-testid="agent-quick-question-more"
							aria-label={label}
							aria-expanded={expanded}
							aria-controls={textId}
							onClick={() => setExpanded(!expanded)}
							// Unfolding only reads: the box keeps focus, as a pick does.
							onMouseDown={(e) => e.preventDefault()}
							className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-ink-soft hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
						>
							{expanded ? (
								<ChevronUpIcon size={16} aria-hidden />
							) : (
								<ChevronDownIcon size={16} aria-hidden />
							)}
						</button>
					)}
				</Tooltip>
			)}
		</li>
	);
}
