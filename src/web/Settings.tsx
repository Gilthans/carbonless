import { GearIcon } from "@primer/octicons-react";
import { useEffect, useId, useRef, useState } from "react";
import { useOpenShortcutsHelp } from "./shortcuts";
import { Tooltip } from "./Tooltip";
import { NOT_PHONE, useMedia } from "./useMedia";
import { ignoreWhitespace, showInvisibles, sideBySide } from "./viewSettings";

/** One on/off setting: a switch row, the whole row its 40px+ target. */
function SwitchRow(props: {
	label: string;
	checked: boolean;
	onChange: (next: boolean) => void;
}) {
	return (
		<button
			type="button"
			role="switch"
			aria-checked={props.checked}
			onClick={() => props.onChange(!props.checked)}
			className="flex min-h-11 w-full items-center justify-between gap-4 rounded-md px-2 text-left text-sm text-ink hover:bg-overlay focus-visible:outline-2 focus-visible:outline-accent"
		>
			{props.label}
			<span
				aria-hidden
				className={`relative h-5 w-9 shrink-0 rounded-full border transition-colors motion-reduce:transition-none ${
					props.checked
						? "border-accent bg-accent"
						: "border-line-strong bg-pressed"
				}`}
			>
				<span
					className={`absolute top-0.5 h-3.5 w-3.5 rounded-full transition-[left] motion-reduce:transition-none ${
						props.checked ? "left-[1.125rem] bg-canvas" : "left-0.5 bg-muted"
					}`}
				/>
			</span>
		</button>
	);
}

/** A keyboard, in the octicons' 16px style (they have none). */
function KeyboardIcon() {
	return (
		<svg
			aria-hidden
			viewBox="0 0 16 16"
			width={16}
			height={16}
			fill="currentColor"
			className="shrink-0"
		>
			<path d="M1.75 3h12.5c.966 0 1.75.784 1.75 1.75v6.5A1.75 1.75 0 0 1 14.25 13H1.75A1.75 1.75 0 0 1 0 11.25v-6.5C0 3.784.784 3 1.75 3Zm0 1.5a.25.25 0 0 0-.25.25v6.5c0 .138.112.25.25.25h12.5a.25.25 0 0 0 .25-.25v-6.5a.25.25 0 0 0-.25-.25ZM3 6h1.5v1.5H3Zm2.75 0h1.5v1.5h-1.5ZM8.5 6H10v1.5H8.5Zm2.75 0h1.5v1.5h-1.5ZM4.5 9h7v1.5h-7Z" />
		</svg>
	);
}

/** The settings themselves; more rows go here. */
function SettingsList() {
	const invisibles = showInvisibles.use();
	const whitespace = ignoreWhitespace.use();
	const split = sideBySide.use();
	return (
		<div className="space-y-1">
			<SwitchRow
				label="Show hidden characters"
				checked={invisibles}
				onChange={showInvisibles.set}
			/>
			<SwitchRow
				label="Ignore whitespace"
				checked={whitespace}
				onChange={ignoreWhitespace.set}
			/>
			<SwitchRow
				label="Side by side"
				checked={split}
				onChange={sideBySide.set}
			/>
		</div>
	);
}

/**
 * The gear in the app bar's last row (so it stays in the compact sticky
 * header): a popover under it, a bottom sheet on a phone. Closed by the gear,
 * Escape from anywhere, a click or focus outside (the backdrop on a phone).
 */
export function Settings() {
	const [open, setOpen] = useState(false);
	const phone = !useMedia(NOT_PHONE);
	const dialog = useRef<HTMLDialogElement>(null);
	const wrapper = useRef<HTMLDivElement>(null);
	const button = useRef<HTMLButtonElement>(null);
	const titleId = useId();
	const dialogId = useId();
	const openHelp = useOpenShortcutsHelp();
	useEffect(() => {
		const d = dialog.current;
		if (!d) return;
		if (d.open) {
			if (typeof d.close === "function") d.close();
			else d.removeAttribute("open");
		}
		if (!open) return;
		if (phone && typeof d.showModal === "function") d.showModal();
		else if (typeof d.show === "function") d.show();
		else d.setAttribute("open", "");
		d.querySelector<HTMLElement>("[role=switch]")?.focus();
	}, [open, phone]);
	// A popover closes on a click or focus anywhere else, and on Escape
	// wherever focus is (back to the gear). The sheet is modal: its own
	// Escape, backdrop and Close do it.
	useEffect(() => {
		if (!open || phone) return;
		const outside = (event: Event) => {
			if (!wrapper.current?.contains(event.target as Node)) setOpen(false);
		};
		const onEscape = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			setOpen(false);
			button.current?.focus();
		};
		document.addEventListener("pointerdown", outside);
		document.addEventListener("focusin", outside);
		document.addEventListener("keydown", onEscape);
		return () => {
			document.removeEventListener("pointerdown", outside);
			document.removeEventListener("focusin", outside);
			document.removeEventListener("keydown", onEscape);
		};
	}, [open, phone]);
	const close = () => {
		setOpen(false);
		button.current?.focus();
	};
	return (
		<div ref={wrapper} className="relative shrink-0">
			<Tooltip content="Settings" describe={false}>
				{(trigger) => (
					<button
						type="button"
						{...trigger}
						ref={(el) => {
							button.current = el;
							trigger.ref(el);
						}}
						aria-label="Settings"
						aria-haspopup="dialog"
						aria-controls={dialogId}
						aria-expanded={open}
						onClick={() => setOpen((o) => !o)}
						className="flex h-10 w-10 items-center justify-center rounded-md text-ink-soft transition-colors hover:bg-overlay hover:text-ink focus-visible:outline-2 focus-visible:outline-accent aria-expanded:bg-overlay aria-expanded:text-ink motion-reduce:transition-none"
					>
						<GearIcon aria-hidden />
					</button>
				)}
			</Tooltip>
			<dialog
				ref={dialog}
				id={dialogId}
				aria-labelledby={titleId}
				data-testid="settings"
				onClose={() => setOpen(false)}
				onCancel={(event) => {
					event.preventDefault();
					close();
				}}
				onKeyDown={(event) => {
					// The popover's Escape is the document's (above).
					if (phone && event.key === "Escape") {
						event.preventDefault();
						close();
					}
				}}
				onClick={(event) => {
					// A click on the sheet's backdrop lands on the dialog itself.
					if (phone && event.target === dialog.current) close();
				}}
				className={
					phone
						? "m-0 mt-auto max-h-[85dvh] w-full max-w-none rounded-t-2xl border-t border-edge bg-surface p-0 text-ink shadow-sheet backdrop:bg-canvas/70 backdrop:backdrop-blur-[2px]"
						: "absolute top-full right-0 left-auto z-40 m-0 mt-1 w-72 rounded-lg border border-edge bg-surface p-0 text-ink shadow-float"
				}
			>
				<div className="flex items-center justify-between border-b border-line py-1 pr-1 pl-4">
					<h2
						id={titleId}
						className="text-xs font-semibold tracking-[0.18em] text-label uppercase"
					>
						Settings
					</h2>
					{phone && (
						<button
							type="button"
							onClick={close}
							className="h-10 rounded-md px-3 text-sm font-medium hover:bg-overlay focus-visible:outline-2 focus-visible:outline-accent"
						>
							Close
						</button>
					)}
				</div>
				<div className={phone ? "px-2 pt-2 pb-6" : "p-2"}>
					<SettingsList />
					{!phone && (
						<button
							type="button"
							onClick={() => {
								close();
								openHelp();
							}}
							className="mt-1 flex min-h-11 w-full items-center gap-2 rounded-md px-2 text-left text-sm text-ink hover:bg-overlay focus-visible:outline-2 focus-visible:outline-accent"
						>
							<KeyboardIcon />
							Keyboard shortcuts
						</button>
					)}
				</div>
			</dialog>
		</div>
	);
}
