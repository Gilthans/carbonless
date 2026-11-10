import type { ReactNode } from "react";
import { type FindMark, splitMarks } from "../../code/Invisibles";

/** Plain text with find marks painted (a path in a header, a name in the tree). */
export function MarkedText(props: {
	text: string;
	marks: readonly FindMark[];
}): ReactNode {
	if (props.marks.length === 0) return props.text;
	let at = 0;
	return splitMarks(props.text, 0, [], props.marks).map((part) => {
		const key = at;
		at += part.text.length;
		return part.find === undefined ? (
			part.text
		) : (
			<span
				key={key}
				data-find-mark={part.find === "mark" || undefined}
				data-find-current={part.find === "current" || undefined}
				className={part.find === "current" ? "find-current" : "find-mark"}
			>
				{part.text}
			</span>
		);
	});
}
