import type { CSSProperties, ReactNode } from "react";
import { Tooltip } from "../Tooltip";

/** Whether an element's text is cut by its ellipsis. */
const isCut = (el: HTMLElement) => el.scrollWidth > el.clientWidth;

/**
 * A hunk's heading (git's function context, e.g. `def foo(self):`): muted
 * code after its row's label, cut with an ellipsis where the row runs out
 * of visible width, the whole text in a tooltip on hover when cut. Plain
 * text: React escapes it, it is never markup.
 */
export function HunkHeading(props: { text: string }) {
	return (
		<Tooltip
			content={<span className="font-mono break-all">{props.text}</span>}
			describe={false}
			lazy
		>
			{(trigger) => (
				// biome-ignore lint/a11y/noStaticElementInteractions: hover only shows the cut text, which the element itself holds.
				<span
					ref={trigger.ref}
					onMouseEnter={(e) => {
						if (isCut(e.currentTarget)) trigger.onMouseEnter();
					}}
					onMouseLeave={trigger.onMouseLeave}
					data-testid="hunk-heading"
					className="ml-2 min-w-0 truncate font-mono text-muted"
				>
					{props.text}
				</span>
			)}
		</Tooltip>
	);
}

/**
 * A non-code row's label (`@@ … @@`, "N hidden lines") with its hunk's
 * heading after it, kept within the diff's visible width (`--diff-w`) less
 * `reserve` (what sits left and right of the label on that row, a CSS
 * length), so the heading's ellipsis shows on screen whatever the table's
 * width. Without a heading, the label alone, as before.
 */
export function Labelled(props: {
	label: ReactNode;
	heading?: string;
	reserve: string;
	className?: string;
}) {
	if (!props.heading) return <>{props.label}</>;
	const style = {
		maxWidth: `calc(var(--diff-w, 100vw) - (${props.reserve}))`,
	} as CSSProperties;
	return (
		<span
			style={style}
			className={`inline-flex items-baseline align-top ${props.className ?? ""}`}
		>
			<span className="shrink-0">{props.label}</span>
			<HunkHeading text={props.heading} />
		</span>
	);
}

/** The right padding `bubblePad` gives a row for `n` bubbles. */
const PAD_RIGHT = ["0.5rem", "3rem", "6rem", "9rem"];

/**
 * Labelled's reserve on a row whose label starts `left` into the diff:
 * the room its bubbles take on the right (`bubbles` of them), or, with the
 * file bubble centred on the row (`centred`, `count` bubbles wide), all of
 * the right half from that bubble on.
 */
export function labelReserve(
	left: string,
	bubbles: number,
	centred?: { count: number },
): string {
	if (centred) {
		return `var(--diff-w, 100vw) / 2 + ${centred.count * 1.25 + 0.25}rem + ${left}`;
	}
	return `${left} + ${PAD_RIGHT[Math.min(bubbles, 3)]}`;
}
