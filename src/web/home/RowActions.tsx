import {
	CalendarIcon,
	ClockIcon,
	HourglassIcon,
	KebabHorizontalIcon,
	NoteIcon,
	ZapIcon,
} from "@primer/octicons-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
	type FormEvent,
	type ReactNode,
	useEffect,
	useId,
	useRef,
	useState,
} from "react";
import type { AnnotationOp, HomeRow, Person } from "../../shared/home";
import { Tooltip } from "../Tooltip";
import { ErrorMessage } from "../ui";
import { useMedia } from "../useMedia";
import { homeQuery, postAnnotation, setRow } from "./homeApi";
import { Avatar } from "./PrRow";
import { minPick, pickedDate, snoozePresets } from "./snooze";

type Panel = "snooze" | "wait" | "note";

const PANELS: { id: Panel; label: string; icon: ReactNode }[] = [
	{ id: "snooze", label: "Snooze", icon: <ClockIcon aria-hidden /> },
	{ id: "wait", label: "Waiting on", icon: <HourglassIcon aria-hidden /> },
	{ id: "note", label: "Note", icon: <NoteIcon aria-hidden /> },
];

const itemClass =
	"flex min-h-10 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-sm text-ink hover:bg-pressed focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent";
const fieldClass =
	"h-10 w-full min-w-0 rounded-md border border-line-strong bg-code px-2.5 text-sm text-ink placeholder:text-faint focus-visible:outline-2 focus-visible:outline-accent";
const smallButton =
	"h-10 rounded-md px-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-accent";

function SnoozePanel(props: { onPick: (op: AnnotationOp) => void }) {
	const [wake, setWake] = useState(true);
	const [picking, setPicking] = useState(false);
	const [date, setDate] = useState("");
	const presets = snoozePresets(new Date());
	const pick = (until: Date) =>
		props.onPick({
			op: "snooze",
			until: until.toISOString(),
			wakeOnActivity: wake,
		});
	const picked = pickedDate(date, new Date());
	const min = minPick(new Date());
	return (
		<div className="space-y-0.5">
			{presets.map((p) => (
				<button
					key={p.label}
					type="button"
					className={itemClass}
					onClick={() => pick(p.until)}
				>
					<ClockIcon aria-hidden className="text-muted" />
					{p.label}
					<span className="ml-auto text-xs text-muted">{p.hint}</span>
				</button>
			))}
			{picking ? (
				<form
					className="flex items-center gap-1.5 px-1 py-0.5"
					onSubmit={(e) => {
						e.preventDefault();
						if (picked) pick(picked);
					}}
				>
					<input
						type="date"
						aria-label="Snooze until"
						min={min}
						value={date}
						onChange={(e) => setDate(e.target.value)}
						className={fieldClass}
						// biome-ignore lint/a11y/noAutofocus: opened to pick a date.
						autoFocus
					/>
					<button
						type="submit"
						aria-label="Snooze to this date"
						disabled={!picked}
						className={`${smallButton} bg-accent text-canvas disabled:opacity-50`}
					>
						OK
					</button>
				</form>
			) : (
				<button
					type="button"
					className={itemClass}
					onClick={() => setPicking(true)}
				>
					<CalendarIcon aria-hidden className="text-muted" />
					Pick a date…
				</button>
			)}
			<div className="mx-1.5 my-1 h-px bg-edge" />
			<button
				type="button"
				role="switch"
				aria-checked={wake}
				onClick={() => setWake((w) => !w)}
				className={itemClass}
			>
				<ZapIcon aria-hidden className="text-muted" />
				Wake on activity too
				<span
					aria-hidden
					className={`relative ml-auto h-5 w-9 shrink-0 rounded-full border ${
						wake ? "border-accent bg-accent" : "border-line-strong bg-pressed"
					}`}
				>
					<span
						className={`absolute top-0.5 h-3.5 w-3.5 rounded-full ${
							wake ? "left-[1.125rem] bg-canvas" : "left-0.5 bg-muted"
						}`}
					/>
				</span>
			</button>
		</div>
	);
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function WaitPanel(props: {
	row: HomeRow;
	viewer: string;
	onPick: (op: AnnotationOp) => void;
}) {
	const { row, viewer } = props;
	const [who, setWho] = useState("");
	// The author, the reviewers, then whoever else the turn names: once each.
	const people: { person: Person; role: string }[] = [];
	const add = (login: string, role: string) => {
		if (same(login, viewer)) return;
		// A team (org/slug) never acts itself: a wait on it could never end.
		if (login.includes("/")) return;
		if (people.some((p) => same(p.person.login, login))) return;
		const person = same(login, row.author.login)
			? row.author
			: (row.people[login] ?? { login, avatarUrl: "" });
		people.push({ person, role });
	};
	add(row.author.login, "author");
	for (const login of row.reviewers ?? []) add(login, "reviewer");
	if (row.turn.kind === "people") {
		for (const login of row.turn.logins) add(login, "");
	}
	const current = row.annotations.waiting?.who;
	const pressed = (login: string) => !!current && same(current, login);
	const submit = (e: FormEvent) => {
		e.preventDefault();
		const login = who.trim().replace(/^@/, "");
		if (login) props.onPick({ op: "wait", who: login });
	};
	return (
		<div className="space-y-0.5">
			{viewer && (
				<button
					type="button"
					aria-pressed={pressed(viewer)}
					className={`${itemClass} aria-pressed:bg-pressed`}
					// "Me" is the viewer's own login: never hides, the turn says you.
					onClick={() => props.onPick({ op: "wait", who: viewer })}
				>
					Me
				</button>
			)}
			{people.map(({ person, role }) => (
				<button
					key={person.login}
					type="button"
					aria-pressed={pressed(person.login)}
					className={`${itemClass} aria-pressed:bg-pressed`}
					onClick={() => props.onPick({ op: "wait", who: person.login })}
				>
					<Avatar person={person} size={20} />
					{person.login}
					{role && <span className="ml-auto text-xs text-muted">{role}</span>}
				</button>
			))}
			<form onSubmit={submit} className="px-1 py-0.5">
				<input
					aria-label="Someone else"
					placeholder="Someone else…"
					value={who}
					onChange={(e) => setWho(e.target.value)}
					autoComplete="off"
					className={fieldClass}
				/>
			</form>
			{current && (
				<div className="flex justify-end px-1 pt-1">
					<button
						type="button"
						// Ends the wait (and a snooze, which a shown row doesn't have).
						onClick={() => props.onPick({ op: "wake" })}
						className={`${smallButton} border border-edge text-ink-soft hover:bg-pressed`}
					>
						Clear
					</button>
				</div>
			)}
		</div>
	);
}

function NotePanel(props: {
	note: string;
	onPick: (op: AnnotationOp) => void;
}) {
	const [text, setText] = useState(props.note);
	return (
		<form
			className="space-y-1.5 p-1"
			onSubmit={(e) => {
				e.preventDefault();
				props.onPick({ op: "note", text: text.trim() });
			}}
		>
			<textarea
				aria-label="Your note"
				value={text}
				maxLength={500}
				onChange={(e) => setText(e.target.value)}
				rows={3}
				className="block w-full resize-none rounded-md border border-line-strong bg-code px-2.5 py-2 text-sm text-ink focus-visible:outline-2 focus-visible:outline-accent"
				// biome-ignore lint/a11y/noAutofocus: opened to write the note.
				autoFocus
			/>
			<div className="flex justify-end gap-1.5">
				<button
					type="button"
					onClick={() => props.onPick({ op: "note", text: "" })}
					className={`${smallButton} border border-edge text-ink-soft hover:bg-pressed`}
				>
					Clear
				</button>
				<button
					type="submit"
					className={`${smallButton} cta font-semibold text-ink hover:brightness-110`}
				>
					Save
				</button>
			</div>
		</form>
	);
}

/**
 * A row's snooze, waiting on and note. With a mouse: three buttons that
 * show on hover or focus, each opening a popover. On touch: a 40px "⋯"
 * that opens the same three in a bottom sheet (no hover, no long-press).
 * Each posts its op and puts the server's row in the cache.
 */
export function RowActions(props: {
	row: HomeRow;
	viewer: string;
	/** The answer hid the row: it moved behind its section's footer. */
	onHidden?: () => void;
}) {
	const { row } = props;
	const hover = useMedia("(hover: hover)");
	const client = useQueryClient();
	const [panel, setPanel] = useState<Panel | null>(null);
	const [sheet, setSheet] = useState(false);
	const wrapper = useRef<HTMLSpanElement>(null);
	const buttons = useRef(new Map<Panel, HTMLButtonElement>());
	const save = useMutation({
		mutationFn: (op: AnnotationOp) => postAnnotation(row, op),
		// A read of Home already under way would land after the answer and
		// put the old row back: it's dropped.
		onMutate: () => client.cancelQueries({ queryKey: homeQuery.queryKey }),
		onSuccess: (answer) => {
			setRow(client, answer);
			setPanel(null);
			setSheet(false);
			if (answer.hidden !== null && row.hidden === null) props.onHidden?.();
		},
	});
	const pick = (op: AnnotationOp) => save.mutate(op);
	// A popover closes on Escape and on a press or focus elsewhere.
	useEffect(() => {
		if (!panel || !hover) return;
		const outside = (e: Event) => {
			if (!wrapper.current?.contains(e.target as Node)) setPanel(null);
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.preventDefault();
				buttons.current.get(panel)?.focus();
				setPanel(null);
			}
		};
		document.addEventListener("pointerdown", outside);
		document.addEventListener("focusin", outside);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("pointerdown", outside);
			document.removeEventListener("focusin", outside);
			document.removeEventListener("keydown", onKey);
		};
	}, [panel, hover]);

	const body = (p: Panel) =>
		p === "snooze" ? (
			<SnoozePanel onPick={pick} />
		) : p === "wait" ? (
			<WaitPanel row={row} viewer={props.viewer} onPick={pick} />
		) : (
			<NotePanel note={row.annotations.note ?? ""} onPick={pick} />
		);

	if (!hover) {
		return (
			<>
				<button
					type="button"
					aria-label={`Actions for #${row.number}`}
					aria-haspopup="dialog"
					onClick={() => {
						setPanel(null);
						setSheet(true);
					}}
					className="relative z-10 -my-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-ink-soft hover:bg-overlay focus-visible:outline-2 focus-visible:outline-accent"
				>
					<KebabHorizontalIcon aria-hidden />
				</button>
				<Sheet
					open={sheet}
					title={`#${row.number}`}
					onClose={() => setSheet(false)}
				>
					{panel ? (
						body(panel)
					) : (
						<div className="space-y-0.5">
							{PANELS.map((p) => (
								<button
									key={p.id}
									type="button"
									className={itemClass}
									onClick={() => setPanel(p.id)}
								>
									<span className="text-muted">{p.icon}</span>
									{p.label}
								</button>
							))}
						</div>
					)}
					{save.isError && <ErrorMessage error={save.error} />}
				</Sheet>
			</>
		);
	}

	return (
		<span
			ref={wrapper}
			data-row-actions
			// Open, above the later rows' z-10 icons (one stacking context).
			className={`relative flex shrink-0 items-center ${
				panel
					? "z-30"
					: "z-10 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
			}`}
		>
			{PANELS.map((p) => (
				<Tooltip key={p.id} content={p.label} describe={false}>
					{(trigger) => (
						<button
							type="button"
							{...trigger}
							ref={(el) => {
								trigger.ref(el);
								if (el) buttons.current.set(p.id, el);
								else buttons.current.delete(p.id);
							}}
							aria-label={p.label}
							aria-haspopup="dialog"
							aria-expanded={panel === p.id}
							onClick={() => setPanel((o) => (o === p.id ? null : p.id))}
							className="flex h-8 w-8 items-center justify-center rounded-md text-muted hover:bg-overlay hover:text-ink focus-visible:outline-2 focus-visible:outline-accent aria-expanded:bg-overlay aria-expanded:text-ink"
						>
							{p.icon}
						</button>
					)}
				</Tooltip>
			))}
			{panel && (
				<Popover label={PANELS.find((p) => p.id === panel)?.label ?? ""}>
					{body(panel)}
					{save.isError && <ErrorMessage error={save.error} />}
				</Popover>
			)}
		</span>
	);
}

function Popover(props: { label: string; children: ReactNode }) {
	const id = useId();
	return (
		<div
			role="dialog"
			aria-labelledby={id}
			className="absolute top-full right-0 z-40 mt-1 w-72 rounded-lg border border-edge bg-overlay p-1.5 text-ink shadow-float"
		>
			<h3
				id={id}
				className="px-2.5 pt-1 pb-1.5 text-xs font-bold tracking-[0.12em] text-faint uppercase"
			>
				{props.label}
			</h3>
			{props.children}
		</div>
	);
}

/** A bottom sheet (modal dialog): Close, Escape or the backdrop close it. */
export function Sheet(props: {
	open: boolean;
	title: string;
	onClose: () => void;
	children: ReactNode;
}) {
	const dialog = useRef<HTMLDialogElement>(null);
	const titleId = useId();
	useEffect(() => {
		const d = dialog.current;
		if (!d) return;
		if (!props.open) {
			if (d.hasAttribute("open")) {
				if (typeof d.close === "function") d.close();
				else d.removeAttribute("open");
			}
			return;
		}
		if (d.hasAttribute("open")) return;
		if (typeof d.showModal === "function") d.showModal();
		else d.setAttribute("open", "");
	}, [props.open]);
	return (
		<dialog
			ref={dialog}
			aria-labelledby={titleId}
			onClose={props.onClose}
			onCancel={(e) => {
				e.preventDefault();
				props.onClose();
			}}
			onKeyDown={(e) => {
				if (e.key === "Escape") {
					e.preventDefault();
					props.onClose();
				}
			}}
			onClick={(e) => {
				// A click on the backdrop lands on the dialog itself.
				if (e.target === dialog.current) props.onClose();
			}}
			className="m-0 mt-auto max-h-[85dvh] w-full max-w-none rounded-t-2xl border-t border-edge bg-surface p-0 text-ink shadow-sheet backdrop:bg-canvas/70 backdrop:backdrop-blur-[2px]"
		>
			<div className="flex items-center justify-between border-b border-line py-1 pr-1 pl-4">
				<h2
					id={titleId}
					className="text-xs font-semibold tracking-[0.18em] text-label uppercase"
				>
					{props.title}
				</h2>
				<button
					type="button"
					onClick={props.onClose}
					className="h-10 rounded-md px-3 text-sm font-medium hover:bg-overlay focus-visible:outline-2 focus-visible:outline-accent"
				>
					Close
				</button>
			</div>
			{props.open && <div className="px-2 pt-2 pb-6">{props.children}</div>}
		</dialog>
	);
}
