/**
 * The Overview's shared pieces: section frames, badges, chips, named icons
 * and small helpers, used by its sections (OverviewPage.tsx, Timeline.tsx).
 */
import {
	CheckIcon,
	CommentIcon,
	FileDiffIcon,
	HubotIcon,
	type Icon,
	MarkGithubIcon,
	SkipIcon,
	TriangleDownIcon,
} from "@primer/octicons-react";
import type { ReactNode } from "react";
import { numberOn } from "../../shared/diffHunk";
import type { PrOverview, ReviewThread } from "../../shared/types";
import { Tooltip } from "../Tooltip";
import { safeHref } from "../ui";

type Review = PrOverview["reviews"][number];
type Thread = ReviewThread;

export function Section(props: { label: string; children: ReactNode }) {
	return (
		<section
			aria-label={props.label}
			className="rounded-xl border border-line bg-surface"
		>
			<h2 className="rounded-t-xl border-b border-line bg-raised px-4 py-3 text-center text-[0.8125rem] font-semibold tracking-[0.2em] text-label uppercase">
				{props.label}
			</h2>
			<div className="space-y-4 px-4 py-3">{props.children}</div>
		</section>
	);
}

export type BadgeTone = "gray" | "red" | "yellow" | "green" | "purple";

export function Badge(props: {
	tone: BadgeTone;
	icon?: Icon;
	children: ReactNode;
}) {
	const tones = {
		gray: "border-line-strong/60 bg-overlay text-ink-soft",
		red: "border-bad/40 bg-bad/10 text-bad",
		yellow: "border-warn/40 bg-warn/10 text-warn",
		green: "border-ok/40 bg-ok/10 text-ok",
		purple: "border-done/40 bg-done/10 text-done",
	};
	const IconEl = props.icon;
	return (
		<span
			className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${tones[props.tone]}`}
		>
			{IconEl && <IconEl size={12} aria-hidden />}
			{props.children}
		</span>
	);
}

/**
 * An icon that carries meaning. Named for screen readers; its name shows in a
 * tooltip on hover, keyboard focus and tap (a 40px-tall hit area that stops at the usual 8px gap).
 */
export function LabeledIcon(props: {
	icon: Icon;
	label: string;
	size?: 12 | 16;
	/** Shown after the icon (e.g. a count); the label stays the name. */
	text?: string;
	className?: string;
}) {
	const IconEl = props.icon;
	return (
		<Tooltip content={props.label} describe={false}>
			{(trigger) => (
				<span
					{...trigger}
					role="img"
					aria-label={props.label}
					// Focusable so keyboard and touch users can read the tooltip.
					// biome-ignore lint/a11y/noNoninteractiveTabindex: the tooltip opens on focus.
					tabIndex={0}
					className={`relative inline-flex shrink-0 cursor-help items-center rounded-sm after:absolute after:top-1/2 after:left-1/2 after:h-10 after:w-8 after:-translate-x-1/2 after:-translate-y-1/2 focus-visible:outline-2 focus-visible:outline-accent ${props.className ?? ""}`}
				>
					<IconEl size={props.size ?? 16} aria-hidden />
					{props.text && <span aria-hidden>{props.text}</span>}
				</span>
			)}
		</Tooltip>
	);
}

export function BotIcon() {
	return <LabeledIcon icon={HubotIcon} label="bot" className="text-muted" />;
}

/** The PR on GitHub, as GitHub's mark (40×40 tap target). */
export function GithubLink({ url }: { url: string }) {
	const href = safeHref(url);
	if (!href) return null;
	return (
		<Tooltip content="View on GitHub" describe={false}>
			{(trigger) => (
				<a
					{...trigger}
					href={href}
					target="_blank"
					rel="noreferrer noopener"
					aria-label="View on GitHub"
					className="-my-2 inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-ink-soft transition-colors hover:bg-overlay hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
				>
					<MarkGithubIcon size={20} aria-hidden />
				</a>
			)}
		</Tooltip>
	);
}

export const REVIEW_ICON: Record<
	Review["state"],
	{ icon: Icon; label: string; className: string }
> = {
	APPROVED: { icon: CheckIcon, label: "Approved", className: "text-ok" },
	CHANGES_REQUESTED: {
		icon: FileDiffIcon,
		label: "Changes requested",
		className: "text-bad",
	},
	COMMENTED: {
		icon: CommentIcon,
		label: "Commented",
		className: "text-muted",
	},
	DISMISSED: {
		icon: SkipIcon,
		label: "Dismissed",
		className: "text-muted",
	},
};

/** A grey bar where text is still on its way. */
export function SkeletonBar(props: { className: string }) {
	return (
		<div
			aria-hidden
			className={`h-3 animate-pulse rounded bg-overlay motion-reduce:animate-none ${props.className}`}
		/>
	);
}

/**
 * A chip with a tooltip. Interactive (`onClick`) chips are buttons; the rest
 * take focus only so keyboard and touch users can read the tooltip. Either
 * way the hit area is 40px tall.
 */
export function Chip(props: {
	tone: BadgeTone;
	icon: Icon;
	tip: string;
	children: ReactNode;
	testId?: string;
	/** A disclosure (`expanded`, with a caret) or a two-state button (`pressed`). */
	toggle?: {
		expanded?: boolean;
		pressed?: boolean;
		/** Inert but still focusable, so its tip can say why. */
		disabled?: boolean;
		controls?: string;
		onClick: () => void;
	};
	/** Keep the tip a description even on a toggle (it explains, not instructs). */
	describeTip?: boolean;
}) {
	const { toggle } = props;
	const className =
		"inline-flex min-h-10 items-center rounded-full focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent";
	const badge = (
		<Badge tone={props.tone} icon={props.icon}>
			{props.children}
			{toggle?.expanded !== undefined && (
				<TriangleDownIcon
					size={12}
					aria-hidden
					className={`-mr-0.5 transition-transform motion-reduce:transition-none ${toggle.expanded ? "rotate-180" : ""}`}
				/>
			)}
		</Badge>
	);
	return (
		// A toggle's tip only says what pressing does; its state is aria-expanded.
		<Tooltip
			content={props.tip}
			hoverDelay={400}
			describe={props.describeTip ?? !toggle}
		>
			{(trigger) =>
				toggle ? (
					<button
						type="button"
						{...trigger}
						data-testid={props.testId}
						aria-expanded={toggle.expanded}
						aria-pressed={toggle.pressed}
						aria-disabled={toggle.disabled || undefined}
						aria-controls={toggle.controls}
						onClick={toggle.disabled ? undefined : toggle.onClick}
						className={`${className} ${toggle.disabled ? "cursor-default" : "cursor-pointer hover:brightness-125"} ${toggle.pressed ? "[&>span]:ring-2 [&>span]:ring-current" : ""}`}
					>
						{badge}
					</button>
				) : (
					<span
						{...trigger}
						data-testid={props.testId}
						// biome-ignore lint/a11y/noNoninteractiveTabindex: the tooltip opens on focus.
						tabIndex={0}
						className={className}
					>
						{badge}
					</span>
				)
			}
		</Tooltip>
	);
}

export const plural = (n: number, word: string) =>
	`${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * The line number the header shows: the marked range's last number on the
 * comment's own side when code is shown (GitHub's hunk may have marked its
 * last line in place of a range it didn't hold), else the server's.
 */
export function headerLine(thread: Thread): number | null {
	const { code } = thread;
	if (!code) return thread.line;
	// The last row numbered on that side, up to the range's end (a hunk
	// fallen back to a deleted last line: the line above it).
	const end = code.rows.findLastIndex((row) => row.marked);
	for (let i = end; i >= 0; i--) {
		const row = code.rows[i];
		const n = row ? numberOn(row, code.anchor.side) : null;
		if (n !== null) return n;
	}
	return thread.line;
}
