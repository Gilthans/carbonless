import { SyncIcon } from "@primer/octicons-react";
import { type KeyboardEvent, type ReactNode, useEffect, useState } from "react";

/** A labelled group of a combobox's suggestions. */
export interface SuggestionGroup<T> {
	label: string;
	options: T[];
	/** Still coming from GitHub: the heading spins over what's known. */
	loading?: boolean;
}

/** How long typing rests before the server is asked. */
export const DEBOUNCE_MS = 150;

export function useDebounced<T>(value: T, ms: number): T {
	const [out, setOut] = useState(value);
	useEffect(() => {
		const t = setTimeout(() => setOut(value), ms);
		return () => clearTimeout(t);
	}, [value, ms]);
	return out;
}

/**
 * A combobox's highlight over `count` options: arrows move it (and open
 * the list), Escape closes an open list. With `autoSelect` the first
 * option is highlighted until the arrows say otherwise; without, none is
 * (-1), so Enter can take what was typed.
 */
export function useSuggestionKeys(props: {
	count: number;
	listOpen: boolean;
	autoSelect?: boolean;
	onOpen: () => void;
	onClose: () => void;
}) {
	const { count, listOpen } = props;
	const [active, setActive] = useState<number | null>(null);
	const current =
		count === 0
			? -1
			: active === null
				? props.autoSelect === false
					? -1
					: 0
				: Math.min(active, count - 1);
	/** True when it handled the key. */
	const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): boolean => {
		if (e.key === "ArrowDown" || e.key === "ArrowUp") {
			if (count === 0) return false;
			e.preventDefault();
			props.onOpen();
			const down = e.key === "ArrowDown";
			if (current === -1) setActive(down ? 0 : count - 1);
			else setActive((current + (down ? 1 : -1) + count) % count);
			return true;
		}
		if (e.key === "Escape" && listOpen) {
			e.preventDefault();
			e.stopPropagation();
			props.onClose();
			return true;
		}
		return false;
	};
	return {
		current,
		/** Highlights option `i` (a hover). */
		setActive,
		/** Back to the default highlight (the input changed). */
		reset: () => setActive(null),
		onKeyDown,
	};
}

/**
 * The listbox of a combobox's suggestions, in groups with a spinner on
 * the ones still loading. The options' ids are `${optionId}-${i}`, `i`
 * counting across groups (the input's aria-activedescendant). A press in
 * it keeps focus in the input.
 */
export function SuggestionList<T>(props: {
	listId: string;
	optionId: string;
	groups: SuggestionGroup<T>[];
	current: number;
	onChoose: (option: T) => void;
	onHover: (i: number) => void;
	render: (option: T, selected: boolean) => ReactNode;
	/** Said above the options (a failed GitHub search). */
	error?: string;
	className?: string;
}) {
	let index = -1;
	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: not an action; it keeps focus in the box while a click picks an option.
		<div
			onMouseDown={(e) => e.preventDefault()}
			className={`max-h-[70dvh] overflow-y-auto rounded-xl border border-edge bg-overlay p-1.5 shadow-float ${props.className ?? ""}`}
		>
			{props.error && (
				<p role="alert" className="px-2.5 py-1.5 text-sm text-warn">
					{props.error}
				</p>
			)}
			<div id={props.listId} role="listbox" aria-label="Suggestions">
				{props.groups.map((g, gi) => {
					const labelId = `${props.listId}-g${gi}`;
					return (
						// biome-ignore lint/a11y/useSemanticElements: a listbox's group of options; a fieldset holds form controls.
						<div
							key={g.label}
							role="group"
							aria-labelledby={labelId}
							aria-busy={!!g.loading}
						>
							<div className="flex items-center gap-1.5 px-2.5 pt-1.5 pb-1 text-xs font-bold tracking-[0.12em] text-faint uppercase">
								<span id={labelId} className="min-w-0 truncate">
									{g.label}
								</span>
								{g.loading && (
									<SyncIcon
										size={12}
										aria-hidden
										className="shrink-0 animate-spin motion-reduce:animate-none"
									/>
								)}
							</div>
							{g.options.map((option) => {
								index++;
								const i = index;
								const selected = i === props.current;
								return (
									<div
										key={i}
										id={`${props.optionId}-${i}`}
										role="option"
										aria-selected={selected}
										tabIndex={-1}
										onClick={() => props.onChoose(option)}
										onKeyDown={() => {}}
										onMouseEnter={() => props.onHover(i)}
										className={`flex min-h-10 cursor-pointer items-center gap-2.5 rounded-lg px-2.5 text-sm text-ink ${
											selected ? "bg-pressed" : ""
										}`}
									>
										{props.render(option, selected)}
									</div>
								);
							})}
						</div>
					);
				})}
			</div>
		</div>
	);
}
