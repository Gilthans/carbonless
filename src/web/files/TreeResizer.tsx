import {
	type PointerEvent,
	type ReactNode,
	useEffect,
	useRef,
	useState,
} from "react";
import { Tooltip } from "../Tooltip";
import { TREE_WIDTH, treeWidthKey, useTreeWidth } from "./treeWidth";

/**
 * The desktop file tree column: the tree at its remembered width and the
 * drag handle, stuck together (the handle is the tree's height). Its own
 * component so a window resize re-renders only this, not the whole page.
 */
export function TreeColumn(props: { tree: ReactNode }) {
	const treeWidth = useTreeWidth();
	return (
		<div className="sticky top-[calc(var(--app-header,0px)+var(--files-bar,0px)+1rem)] flex max-h-[calc(100dvh-var(--app-header,0px)-var(--files-bar,0px)-2rem)] shrink-0 self-start">
			<aside style={{ width: treeWidth.width }} className="overflow-y-auto">
				{props.tree}
			</aside>
			<TreeResizer {...treeWidth} onWidth={treeWidth.set} />
		</div>
	);
}

/**
 * The drag handle between the file tree and the diffs (desktop): a thin
 * line with a wide hit area. Dragging it (mouse or touch, with pointer
 * capture) resizes the tree; the keyboard steps it (ArrowLeft/Right, Shift
 * for four steps, Home/End for the ends); Enter or a double click resets it.
 */
export function TreeResizer(props: {
	width: number;
	min: number;
	max: number;
	/** Asked for a width; the owner clamps and remembers it. */
	onWidth: (width: number) => void;
}) {
	const [dragging, setDragging] = useState(false);
	const drag = useRef<{ id: number; x: number; width: number } | null>(null);

	// While dragging, the resize cursor shows wherever the captured pointer
	// goes and nothing gets selected (html[data-resizing] in index.css).
	useEffect(() => {
		if (!dragging) return;
		document.documentElement.setAttribute("data-resizing", "");
		return () => document.documentElement.removeAttribute("data-resizing");
	}, [dragging]);

	// Also the capture going away on its own (the window losing the
	// pointer to a dialog, the node detached): no stale drag survives it.
	const end = (e: PointerEvent<HTMLDivElement>) => {
		if (drag.current?.id !== e.pointerId) return;
		drag.current = null;
		setDragging(false);
		if (e.currentTarget.hasPointerCapture(e.pointerId)) {
			e.currentTarget.releasePointerCapture(e.pointerId);
		}
	};

	const line = dragging
		? "w-0.5 bg-accent"
		: "w-px bg-line group-hover:bg-line-strong group-focus-visible:w-0.5 group-focus-visible:bg-accent";
	return (
		<Tooltip content="Resize file tree" describe={false} dismissKey={dragging}>
			{(trigger) => (
				// biome-ignore lint/a11y/useSemanticElements: a focusable separator with a value is ARIA's window splitter; <hr> is void and can't hold the hit area.
				<div
					{...trigger}
					role="separator"
					aria-orientation="vertical"
					aria-label="Resize file tree"
					aria-valuenow={props.width}
					aria-valuemin={props.min}
					aria-valuemax={props.max}
					tabIndex={0}
					data-dragging={dragging || undefined}
					onPointerDown={(e) => {
						// A fresh primary press always starts a drag: one whose
						// capture was lost without an up or cancel is forgotten.
						if (e.button !== 0) return;
						drag.current = {
							id: e.pointerId,
							x: e.clientX,
							width: props.width,
						};
						e.currentTarget.setPointerCapture(e.pointerId);
						setDragging(true);
					}}
					onPointerMove={(e) => {
						const d = drag.current;
						if (d?.id !== e.pointerId) return;
						props.onWidth(d.width + (e.clientX - d.x));
					}}
					onPointerUp={end}
					onPointerCancel={end}
					onLostPointerCapture={end}
					onDoubleClick={() => props.onWidth(TREE_WIDTH.default)}
					onKeyDown={(e) => {
						trigger.onKeyDown(e);
						const next = treeWidthKey(e.key, e.shiftKey, props);
						if (next === null) return;
						e.preventDefault();
						props.onWidth(next);
					}}
					className="group flex w-4 shrink-0 cursor-col-resize touch-none justify-center self-stretch outline-none pointer-coarse:w-6"
				>
					<span aria-hidden className={`h-full ${line}`} />
				</div>
			)}
		</Tooltip>
	);
}
