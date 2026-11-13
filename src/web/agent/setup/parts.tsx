import { CheckIcon, CopyIcon, InfoIcon, XIcon } from "@primer/octicons-react";
import { type ReactNode, useRef, useState } from "react";
import { copyText } from "../../copyText";
import { Tooltip } from "../../Tooltip";

/** A plain bordered button (≥40px). */
export const BUTTON =
	"flex h-10 shrink-0 items-center justify-center gap-1.5 rounded-md border border-line-strong px-3 text-sm font-medium text-ink-soft hover:bg-overlay hover:text-ink focus-visible:outline-2 focus-visible:outline-accent disabled:text-faint disabled:hover:bg-transparent";

export const FIELD =
	"block h-10 w-full min-w-0 rounded-md border border-line-strong bg-code px-3 font-mono text-xs text-code-ink read-only:text-ink-soft focus-visible:border-accent focus-visible:outline-2 focus-visible:outline-accent";

/** A small uppercase section heading (the connected view's Status, Activity). */
export const SECTION =
	"text-xs font-semibold tracking-[0.1em] text-faint uppercase";

/** A harness choice: raised, the agent edge when picked. */
export const PICK =
	"flex min-h-10 min-w-0 cursor-pointer items-center gap-2 rounded-md border bg-raised px-3 text-sm focus-visible:outline-2 focus-visible:outline-accent has-focus-visible:outline-2 has-focus-visible:outline-accent";
export const PICKED =
	"border-agent-edge text-ink shadow-[inset_0_0_0_1px_var(--color-agent-edge)]";
export const UNPICKED = "border-line text-ink-soft hover:text-ink";

/** A labelled field: its label above it. */
export function Field(props: { label: string; children: ReactNode }) {
	return (
		<div className="grid min-w-0 gap-1">
			<span className="text-sm text-muted">{props.label}</span>
			{props.children}
		</div>
	);
}

/** A numbered step: the number in a circle and its title (an h3), then its body. */
export function Step(props: { n: number; title: string; children: ReactNode }) {
	return (
		<section className="flex min-w-0 flex-col gap-2.5">
			<div className="flex items-center gap-2.5">
				<span
					aria-hidden
					className="flex size-[22px] shrink-0 items-center justify-center rounded-full bg-overlay text-xs font-bold text-agent-ink"
				>
					{props.n}
				</span>
				<h3 className="text-sm font-semibold text-ink">{props.title}</h3>
			</div>
			{props.children}
		</section>
	);
}

/** What a session that's already running does to pick up a line just added. */
export const RELOAD_HINT = "Session already running? /reload-plugins";

/** A Copy press's outcome: none yet, on the clipboard, or refused. */
type Copied = "ok" | "failed" | null;

const copyWord = (copied: Copied) =>
	copied === "ok" ? "Copied" : copied === "failed" ? "Copy failed" : "Copy";

function CopyMark(props: { copied: Copied }) {
	if (props.copied === "ok")
		return <CheckIcon size={16} aria-hidden className="text-ok" />;
	if (props.copied === "failed")
		return <XIcon size={16} aria-hidden className="text-bad" />;
	return <CopyIcon size={16} aria-hidden />;
}

/**
 * Copies `text` and says how it went. When the browser refuses, the line
 * is selected instead, for the reviewer to copy by hand.
 */
async function copyInto(
	text: string,
	line: HTMLInputElement | null,
	done: (copied: Copied) => void,
) {
	const ok = await copyText(text);
	done(ok ? "ok" : "failed");
	if (!ok) {
		line?.focus();
		line?.select();
	}
}

/**
 * One line to copy: read-only, selected on focus, with an icon Copy button
 * and, with `hint`, an info icon whose tooltip (and name) is the hint.
 * A new `value` starts the Copy over.
 */
export function CopyRow(props: {
	label: string;
	value: string;
	testId: string;
	hint?: string;
}) {
	const [copied, setCopied] = useState<{ value: string; c: Copied } | null>(
		null,
	);
	const shown = copied?.value === props.value ? copied.c : null;
	const field = useRef<HTMLInputElement>(null);
	return (
		<div className="flex min-w-0 gap-1.5">
			<input
				ref={field}
				readOnly
				aria-label={props.label}
				data-testid={props.testId}
				value={props.value}
				onFocus={(e) => e.currentTarget.select()}
				className={FIELD}
			/>
			<Tooltip content={copyWord(shown)} describe={false}>
				{(trigger) => (
					<button
						type="button"
						{...trigger}
						aria-label={`Copy ${props.label.toLowerCase()}`}
						onClick={() => {
							const value = props.value;
							void copyInto(value, field.current, (c) =>
								setCopied({ value, c }),
							);
						}}
						className={`${BUTTON} w-10 px-0`}
					>
						<CopyMark copied={shown} />
					</button>
				)}
			</Tooltip>
			{props.hint && (
				<Tooltip content={props.hint} describe={false}>
					{(trigger) => (
						<span
							{...trigger}
							role="img"
							aria-label={props.hint}
							data-testid={`${props.testId}-hint`}
							// Focusable so keyboard and touch users get the tip.
							// biome-ignore lint/a11y/noNoninteractiveTabindex: the tooltip opens on focus.
							tabIndex={0}
							className="flex size-10 shrink-0 items-center justify-center rounded-md text-muted focus-visible:outline-2 focus-visible:outline-accent"
						>
							<InfoIcon size={16} aria-hidden />
						</span>
					)}
				</Tooltip>
			)}
		</div>
	);
}

/** The modal's footer: its buttons on one row, under a line. */
export function Footer(props: { children: ReactNode }) {
	return (
		<div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-line px-4 py-2.5 sm:px-5">
			{props.children}
		</div>
	);
}

/** The footer's Close. */
export function CloseButton(props: { onClose(): void }) {
	return (
		<button
			type="button"
			onClick={props.onClose}
			className={`${BUTTON} ml-auto`}
		>
			Close
		</button>
	);
}

/** A failure's message, in red, read out when it appears. */
export function ErrorLine(props: { children: ReactNode; testId?: string }) {
	return (
		<p
			role="alert"
			data-testid={props.testId}
			className="min-w-0 text-sm break-words text-bad"
		>
			{props.children}
		</p>
	);
}
