import {
	AlertIcon,
	ChevronDownIcon,
	ChevronUpIcon,
	XIcon,
} from "@primer/octicons-react";
import { type ReactNode, useEffect, useRef } from "react";
import { Spinner } from "../../Spinner";
import { useShortcutHelp } from "../../shortcuts";
import { Tooltip } from "../../Tooltip";

const ICON_BUTTON =
	"flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-ink-soft transition-colors hover:bg-overlay hover:text-ink focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-ink-soft motion-reduce:transition-none";

/** An icon button: the label is its tooltip and its accessible name. */
function IconButton(props: {
	label: string;
	onClick: () => void;
	disabled?: boolean;
	className?: string;
	children: ReactNode;
}) {
	return (
		<Tooltip content={props.label} describe={false}>
			{(trigger) => (
				<button
					type="button"
					{...trigger}
					aria-label={props.label}
					disabled={props.disabled}
					onClick={props.onClick}
					className={`${ICON_BUTTON} ${props.className ?? ""}`}
				>
					{props.children}
				</button>
			)}
		</Tooltip>
	);
}

/**
 * The Find in PR bar on Files changed: the box (Enter next, Shift+Enter
 * previous, Escape close), "Match case", the count, a spinner while hunks
 * are still arriving, a Retry for files that couldn't be searched, and
 * previous / next / close. State and the search live with the caller.
 */
export function FindBar(props: {
	term: string;
	onTerm: (term: string) => void;
	/** The caret's place and the hit count; null with an empty term (nothing is searched). */
	count: { at: number; of: number } | null;
	/** Hunks are still arriving: the count isn't final. */
	searching: boolean;
	/** Files that couldn't be searched. */
	failed: number;
	onRetry: () => void;
	onNext: () => void;
	onPrevious: () => void;
	onClose: () => void;
	focusSeq: number;
	matchCase: boolean;
	onMatchCase: (on: boolean) => void;
}) {
	const box = useRef<HTMLInputElement>(null);
	useShortcutHelp([
		{ keys: "Enter", label: "Next match", group: "Files changed" },
		{ keys: "Shift+Enter", label: "Previous match", group: "Files changed" },
		{ keys: "Escape", label: "Close Find in PR", group: "Files changed" },
	]);
	useEffect(() => {
		if (props.focusSeq === 0) return;
		box.current?.focus();
		box.current?.select();
	}, [props.focusSeq]);

	const stepless = !props.count || props.count.of === 0;
	const failedLabel = `${props.failed} ${props.failed === 1 ? "file" : "files"} couldn't be searched · Retry`;
	const caseLabel = "Match case";

	return (
		// biome-ignore lint/a11y/useSemanticElements: jsdom doesn't give <search> its role, so tests couldn't find the bar.
		<div
			role="search"
			aria-label="Find in PR"
			data-testid="find-bar"
			className="flex items-center gap-1 border-b border-line bg-surface px-2 py-1"
		>
			<div className="relative min-w-0 flex-1 sm:max-w-sm">
				<input
					ref={box}
					type="search"
					data-testid="find-box"
					aria-label="Find in PR"
					placeholder="Find in PR"
					autoComplete="off"
					spellCheck={false}
					value={props.term}
					onChange={(e) => props.onTerm(e.target.value)}
					onKeyDown={(e) => {
						// Enter that confirms an IME composition isn't a step.
						if (e.nativeEvent.isComposing || e.keyCode === 229) return;
						if (e.key === "Enter") {
							e.preventDefault();
							if (e.shiftKey) props.onPrevious();
							else props.onNext();
						} else if (e.key === "Escape") {
							e.preventDefault();
							props.onClose();
						}
					}}
					className="h-10 w-full rounded-md border border-line bg-canvas pr-10 pl-3 text-sm text-ink placeholder:text-muted focus-visible:outline-2 focus-visible:outline-accent"
				/>
				<Tooltip content={caseLabel} describe={false}>
					{(trigger) => (
						<button
							type="button"
							{...trigger}
							aria-label={caseLabel}
							aria-pressed={props.matchCase}
							onClick={() => props.onMatchCase(!props.matchCase)}
							className={`absolute top-0 right-0 flex h-10 w-10 items-center justify-center rounded-md text-sm font-medium focus-visible:outline-2 focus-visible:outline-accent ${
								props.matchCase
									? "bg-overlay text-ink"
									: "text-muted hover:bg-overlay hover:text-ink"
							}`}
						>
							Aa
						</button>
					)}
				</Tooltip>
			</div>
			{/* Always there, so the first count is announced and showing it moves nothing. */}
			<span
				data-testid="find-count"
				aria-live="polite"
				className="min-w-[7ch] shrink-0 text-right text-sm text-muted tabular-nums sm:min-w-[10ch]"
			>
				{props.count && (
					<>
						<span className="hidden sm:inline">
							{props.count.at} of {props.count.of}
						</span>
						<span className="sm:hidden">
							{props.count.at}/{props.count.of}
						</span>
					</>
				)}
			</span>
			<span className="flex h-4 w-4 shrink-0 items-center justify-center">
				{props.searching && props.count && <Spinner label="Searching files…" />}
			</span>
			{props.failed > 0 && (
				<IconButton label={failedLabel} onClick={props.onRetry}>
					<AlertIcon aria-hidden className="text-warn" />
				</IconButton>
			)}
			<IconButton
				label="Previous (Shift+Enter)"
				onClick={props.onPrevious}
				disabled={stepless}
			>
				<ChevronUpIcon aria-hidden />
			</IconButton>
			<IconButton
				label="Next (Enter)"
				onClick={props.onNext}
				disabled={stepless}
			>
				<ChevronDownIcon aria-hidden />
			</IconButton>
			<IconButton label="Close (Esc)" onClick={props.onClose}>
				<XIcon aria-hidden />
			</IconButton>
		</div>
	);
}
