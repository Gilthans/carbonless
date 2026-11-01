import { SyncIcon } from "@primer/octicons-react";
import type { ReactNode } from "react";
import { Tooltip } from "./Tooltip";

/**
 * The spinning sync arrows alone, `aria-hidden`: for a spinner inside
 * something that has its own name and tooltip (a button, a chip). Still
 * under reduced motion.
 */
export function SpinnerIcon(props: { size?: number; className?: string }) {
	return (
		<SyncIcon
			size={props.size ?? 16}
			aria-hidden
			className={`animate-spin motion-reduce:animate-none ${props.className ?? ""}`}
		/>
	);
}

/**
 * Something is loading here (design principle 8): the spinning icon, with
 * a tooltip and an accessible name saying what (`label`, "Loading
 * comments"), and `children` as visible text beside it when given
 * ("Opening…"). `role="status"` gives tests and assistive tech a named
 * landmark to find; an icon-only one isn't read out when it appears (no
 * text inside), so many on a page don't flood a screen reader.
 */
export function Spinner(props: {
	label: string;
	size?: number;
	className?: string;
	testId?: string;
	children?: ReactNode;
}) {
	return (
		<Tooltip content={props.label} describe={false}>
			{(trigger) => (
				<span
					{...trigger}
					role="status"
					aria-label={props.label}
					data-testid={props.testId}
					className={`inline-flex shrink-0 items-center gap-2 text-muted ${props.className ?? ""}`}
				>
					<SpinnerIcon size={props.size} />
					{props.children}
				</span>
			)}
		</Tooltip>
	);
}

/** A grey bar where text is still on its way (a skeleton's line). */
export function SkeletonBar(props: { className: string }) {
	return (
		<div
			aria-hidden
			className={`h-3 animate-pulse rounded bg-overlay motion-reduce:animate-none ${props.className}`}
		/>
	);
}
