import { useEffect, useRef, useState } from "react";
import { dropLosesText, useThreadWrites } from "../threads/threadWrites";
import { useControlUnder } from "./floatClear";

/**
 * The phone's floating Files button (opens the tree's sheet). It makes way
 * while a comment is being written (a box has focus) or one was refused,
 * and while a card's control (a composer's, a thread's) is under it: it
 * would cover their buttons (CAR-248). Its own component, so showing and
 * hiding it, often while scrolling, re-renders nothing else. Hidden by
 * visibility, never by display: it keeps its place, read live to tell
 * what is under it.
 */
export function FilesFab(props: { onOpen: () => void }) {
	const writing = useWritingHere();
	const refused = useThreadWrites().refused.some(
		(f) => dropLosesText(f) && !f.retrying,
	);
	const ref = useRef<HTMLButtonElement>(null);
	const under = useControlUnder(ref, true);
	const shown = !writing && !refused && !under;
	return (
		<button
			ref={ref}
			type="button"
			aria-label="Files"
			aria-haspopup="dialog"
			data-fab-hidden={
				shown ? undefined : writing ? "writing" : refused ? "refused" : "card"
			}
			onClick={props.onOpen}
			className={`fixed right-[calc(1rem+var(--drawer-push,0px))] bottom-4 z-30 flex h-12 items-center gap-2 cta rounded-full px-5 text-sm font-semibold text-ink hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${shown ? "" : "invisible"}`}
		>
			<span aria-hidden>☰</span>
			Files
		</button>
	);
}

/** A text box on the page has focus (a comment or a reply being written). */
function useWritingHere(): boolean {
	const [writing, setWriting] = useState(false);
	useEffect(() => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const update = () =>
			setWriting(document.activeElement instanceof HTMLTextAreaElement);
		// Focus moving between two boxes: read where it lands.
		const left = () => {
			clearTimeout(timer);
			timer = setTimeout(update, 0);
		};
		document.addEventListener("focusin", update);
		document.addEventListener("focusout", left);
		return () => {
			clearTimeout(timer);
			document.removeEventListener("focusin", update);
			document.removeEventListener("focusout", left);
		};
	}, []);
	return writing;
}
