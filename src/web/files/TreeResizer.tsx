import { type PointerEvent, useEffect, useRef, useState } from "react";
import { Tooltip } from "../Tooltip";
import { TREE_WIDTH, treeWidthKey } from "./treeWidth";

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

	// While dragging, nothing gets selected and the cursor stays a resize
	// cursor wherever the pointer goes.
	useEffect(() => {
		if (!dragging) return;
		const { cursor, userSelect } = document.body.style;
		document.body.style.cursor = "col-resize";
		document.body.style.userSelect = "none";
		return () => {
			document.body.style.cursor = cursor;
			document.body.style.userSelect = userSelect;
		};
	}, [dragging]);

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
						if (e.button !== 0 || drag.current) return;
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
					onDoubleClick={() => props.onWidth(TREE_WIDTH.default)}
					onKeyDown={(e) => {
						trigger.onKeyDown(e);
						const next = treeWidthKey(e.key, e.shiftKey, props);
						if (next === null) return;
						e.preventDefault();
						props.onWidth(next);
					}}
					className="group flex w-4 shrink-0 cursor-col-resize touch-none justify-center self-stretch outline-none"
				>
					<span aria-hidden className={`h-full ${line}`} />
				</div>
			)}
		</Tooltip>
	);
}
