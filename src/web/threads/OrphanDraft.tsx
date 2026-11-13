import { PencilIcon, TrashIcon } from "@primer/octicons-react";
import { type ReactNode, useRef, useState } from "react";
import { type Copied, CopyMark, copyInto, copyWord } from "../CopyMark";
import { LabeledIcon } from "../overview/parts";
import { Tooltip } from "../Tooltip";
import { COMMENT_SURFACE } from "./Conversation";

/**
 * A draft nothing else can show (its thread or comment is gone or not
 * listed, or this session doesn't write): why in a few words, its text,
 * Copy, and Discard.
 */
export function OrphanDraft(props: {
	/** Why it shows here ("Thread not listed", "Comment gone"). */
	label: string;
	text: string;
	onDiscard: () => void;
}) {
	const { text } = props;
	const [copied, setCopied] = useState<Copied>(null);
	const shown = useRef<HTMLParagraphElement>(null);
	const button = (
		label: string,
		icon: ReactNode,
		onClick: () => void,
		tone = "text-ink-soft",
	) => (
		<Tooltip content={label} describe={false}>
			{(trigger) => (
				<button
					{...trigger}
					type="button"
					aria-label={label}
					onClick={onClick}
					className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-md hover:bg-overlay focus-visible:outline-2 focus-visible:outline-accent ${tone}`}
				>
					{icon}
				</button>
			)}
		</Tooltip>
	);
	return (
		<li
			data-testid="orphan-draft"
			className="min-w-0 overflow-hidden rounded-lg border border-edge bg-surface"
		>
			<div className="flex items-center gap-1.5 border-b border-line bg-band py-0.5 pr-1 pl-2.5 text-xs text-muted">
				<LabeledIcon icon={PencilIcon} label="Draft" className="text-warn" />
				<span className="min-w-0 flex-1 truncate">{props.label}</span>
				{button(copyWord(copied), <CopyMark copied={copied} />, () => {
					// When the browser won't copy, it says so and selects the
					// text, to copy by hand.
					void copyInto(text, shown.current, setCopied);
				})}
				{button(
					"Discard",
					<TrashIcon size={16} aria-hidden />,
					props.onDiscard,
					"text-bad",
				)}
			</div>
			<p
				ref={shown}
				className={`${COMMENT_SURFACE} m-2 text-sm whitespace-pre-wrap break-words`}
			>
				{text}
			</p>
		</li>
	);
}
