import { useRef, useState } from "react";
import { type Copied, CopyMark, copyInto, copyWord } from "./CopyMark";
import { Tooltip } from "./Tooltip";

const ICON_BUTTON =
	"flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-faint hover:bg-pressed hover:text-ink focus-visible:outline-2 focus-visible:outline-accent";

/** A 40px icon button with its tooltip and accessible name. */
export function IconButton(props: {
	label: string;
	onClick: () => void;
	children: React.ReactNode;
}) {
	return (
		<Tooltip content={props.label} describe={false}>
			{(trigger) => (
				<button
					type="button"
					{...trigger}
					aria-label={props.label}
					onClick={props.onClick}
					className={ICON_BUTTON}
				>
					{props.children}
				</button>
			)}
		</Tooltip>
	);
}

/** A command to run by hand, with a copy button. */
export function Command(props: { command: string }) {
	const [copied, setCopied] = useState<Copied>(null);
	const shown = useRef<HTMLElement>(null);
	return (
		<div className="flex min-w-0 items-center gap-1">
			<code
				ref={shown}
				data-testid="update-command"
				className="min-w-0 flex-1 overflow-x-auto rounded bg-code px-2 py-1 font-mono text-xs whitespace-nowrap text-code-ink select-all"
			>
				{props.command}
			</code>
			<IconButton
				label={copyWord(copied, "Copy command")}
				onClick={() => {
					void copyInto(props.command, shown.current, setCopied);
				}}
			>
				<CopyMark copied={copied} />
			</IconButton>
		</div>
	);
}
