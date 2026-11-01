import { SyncIcon } from "@primer/octicons-react";
import { Tooltip } from "./Tooltip";

/**
 * Something is loading here (design principle 8): the sync arrows spinning,
 * with a tooltip and an accessible name saying what (`label`, "Loading
 * comments"). `role="status"`, so it is announced and found by its name.
 */
export function Spinner(props: {
	label: string;
	size?: number;
	className?: string;
	testId?: string;
}) {
	return (
		<Tooltip content={props.label} describe={false}>
			{(trigger) => (
				<span
					{...trigger}
					role="status"
					aria-label={props.label}
					data-testid={props.testId}
					className={`inline-flex shrink-0 items-center text-muted ${props.className ?? ""}`}
				>
					<SyncIcon
						size={props.size ?? 16}
						aria-hidden
						className="animate-spin motion-reduce:animate-none"
					/>
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
