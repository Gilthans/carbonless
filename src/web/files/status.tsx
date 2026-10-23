import type { FileView } from "../../shared/types";

export type FileProgress =
	| "not started"
	| "partly done"
	| "done"
	| "crossed off";

export function fileProgress(file: FileView): FileProgress {
	if (file.crossedOff) return "crossed off";
	if (file.done) return "done";
	return file.clusters.some((c) => c.state !== "unreviewed")
		? "partly done"
		: "not started";
}

/** The distinct reasons the file's clusters were crossed off with. */
export function crossOffReasons(file: FileView): string[] {
	const reasons = file.clusters.flatMap((c) =>
		c.state === "crossed-off" && c.reason ? [c.reason] : [],
	);
	return [...new Set(reasons)];
}

const ICON: Record<FileProgress, { glyph: string; className: string }> = {
	"not started": { glyph: "○", className: "text-slate-400" },
	"partly done": { glyph: "◐", className: "text-amber-600" },
	done: { glyph: "✓", className: "text-green-700" },
	"crossed off": { glyph: "⊘", className: "text-purple-600" },
};

export function StatusIcon({ file }: { file: FileView }) {
	const progress = fileProgress(file);
	const icon = ICON[progress];
	return (
		<span
			role="img"
			aria-label={progress}
			title={progress}
			className={`inline-block w-4 shrink-0 text-center ${icon.className}`}
		>
			{icon.glyph}
		</span>
	);
}

export function AddDel({ file }: { file: FileView }) {
	return (
		<span className="shrink-0 font-mono text-xs tabular-nums">
			<span className="text-green-700">+{file.additions}</span>{" "}
			<span className="text-red-700">−{file.deletions}</span>
		</span>
	);
}
