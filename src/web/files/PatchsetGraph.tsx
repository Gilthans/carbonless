import { CheckIcon } from "@primer/octicons-react";
import { useQueries } from "@tanstack/react-query";
import {
	type ReactNode,
	type PointerEvent as ReactPointerEvent,
	useEffect,
	useRef,
	useState,
} from "react";
import type { RereviewAnswer, SessionInfo, Shape } from "../../shared/types";
import { rereviewQuery } from "../api";
import { RelativeTime } from "../RelativeTime";
import { Spinner } from "../Spinner";
import { useShortcut } from "../shortcuts";
import { Tooltip, type TooltipTriggerProps } from "../Tooltip";
import { NOT_PHONE, useMedia } from "../useMedia";
import {
	type Comparison,
	type ComparisonBase,
	positionOf,
	type Viewing,
} from "./comparison";
import {
	commitsLabel,
	connectorLine,
	connectorTone,
	type ToRead,
} from "./graphCards";

/** The rail's last slot is always this wide: "up to date", or the head connector and dot. */
export const TAIL_WIDTH = { desktop: 150, phone: 84 } as const;

/** A dot of the rail. */
interface Dot {
	id: string;
	kind: "branch" | "patchset" | "snapshot" | "head";
	/** Under the dot. */
	label: string;
	/** Its place on the rail (positionOf): 0 the branch, n patch set n, the head after. */
	position: number;
	/** What viewing it stands for (none for the branch). */
	viewing?: Viewing;
	/** What comparison base it stands for (none for the head). */
	base?: ComparisonBase;
	/** The commit it is at (a patch set's head; the branch's merge base). */
	oid: string;
	patchset?: SessionInfo["patchsets"][number];
}

const short = (oid: string) => oid.slice(0, 7);

const sameViewing = (a: Viewing | undefined, b: Viewing | null) =>
	!!a &&
	!!b &&
	a.kind === b.kind &&
	(a.kind === "patchset"
		? a.number === (b as { number: number }).number
		: a.oid === (b as { oid: string }).oid);

const sameBase = (a: ComparisonBase | undefined, b: ComparisonBase) =>
	!!a &&
	a.kind === b.kind &&
	(a.kind !== "patchset" || a.number === (b as { number: number }).number);

/** The PR's head is newer than the newest dot the reviewer has. */
export function headIsNewer(session: SessionInfo): boolean {
	const head = session.head;
	if (!head) return false;
	const newest = session.patchsets.at(-1)?.head ?? session.snapshotHead;
	return head.oid !== newest;
}

/** The rail's dots, left to right, and whether the last slot holds the head. */
export function railDots(
	session: SessionInfo,
	viewing: Viewing | null,
): { dots: Dot[]; head: Dot | null } {
	const latest = session.patchsets.at(-1);
	const mergeBase =
		latest?.mergeBase ?? session.head?.mergeBase ?? session.snapshotHead;
	const dots: Dot[] = [
		{
			id: "branch",
			kind: "branch",
			label: session.head?.baseBranch ?? "base",
			position: 0,
			base: { kind: "branch" },
			oid: mergeBase,
		},
		...session.patchsets.map(
			(p): Dot => ({
				id: `ps${p.number}`,
				kind: "patchset",
				label: `PS${p.number}`,
				position: p.number,
				viewing: { kind: "patchset", number: p.number },
				base: { kind: "patchset", number: p.number },
				oid: p.head,
				patchset: p,
			}),
		),
	];
	const numbers = session.patchsets.map((p) => p.number);
	// Before any patch set, the snapshot being reviewed is a dot of its
	// own; so is a viewed head that is neither it nor the PR's head.
	const snapshotOid =
		viewing?.kind === "head" && viewing.oid !== session.head?.oid
			? viewing.oid
			: session.patchsets.length === 0
				? session.snapshotHead
				: null;
	if (snapshotOid !== null && snapshotOid !== session.head?.oid) {
		dots.push({
			id: "snapshot",
			kind: "snapshot",
			label: short(snapshotOid),
			position: positionOf({ kind: "head", oid: snapshotOid }, numbers),
			viewing: { kind: "head", oid: snapshotOid },
			oid: snapshotOid,
		});
	}
	const head =
		session.head && headIsNewer(session)
			? {
					id: "head",
					kind: "head" as const,
					label: "head",
					position: positionOf(
						{ kind: "head", oid: session.head.oid },
						numbers,
					),
					viewing: { kind: "head" as const, oid: session.head.oid },
					oid: session.head.oid,
				}
			: null;
	return { dots, head };
}

const DOT_TONE: Record<Dot["kind"], string> = {
	branch: "border-line-strong bg-line-strong",
	patchset: "border-ok-fill bg-ok-fill",
	snapshot: "border-line-strong bg-surface",
	head: "border-dashed border-warn bg-transparent",
};

/** The dot itself: 14px, in its kind's color, ringed by the marker on it. */
function DotGlyph(props: { dot: Dot; viewing: boolean; base: boolean }) {
	const ring = props.viewing
		? "border-accent bg-accent shadow-[0_0_0_4px_color-mix(in_srgb,var(--color-accent)_35%,transparent)]"
		: props.base
			? "border-done shadow-[0_0_0_4px_color-mix(in_srgb,var(--color-done)_35%,transparent)]"
			: "";
	return (
		<span
			aria-hidden
			className={`block h-3.5 w-3.5 rounded-full border-2 ${DOT_TONE[props.dot.kind]} ${ring}`}
		/>
	);
}

/** A marker on the rail: viewing (accent) or comparison base (violet). */
function Marker(props: {
	kind: "viewing" | "base";
	phone: boolean;
	onPointerDown: (e: ReactPointerEvent<HTMLButtonElement>) => void;
	dragging: boolean;
}) {
	const base = props.kind === "base";
	const label = base ? "comparison base" : "viewing";
	return (
		<Tooltip
			content={
				base
					? "Comparison base: the diff shown starts here. Drag to move it."
					: "Viewing: the diff shown ends here. Drag to move it."
			}
			describe={false}
		>
			{(trigger) => (
				<button
					type="button"
					{...trigger}
					aria-label={label}
					data-testid={base ? "marker-base" : "marker-viewing"}
					data-dragging={props.dragging || undefined}
					onPointerDown={props.onPointerDown}
					// The rail scrolls sideways on a phone; a drag on a marker must not.
					style={{ touchAction: "none" }}
					className={`relative inline-flex min-h-10 cursor-grab items-center rounded-full px-1.5 text-[10.5px] tracking-[0.04em] uppercase select-none focus-visible:outline-2 focus-visible:outline-accent active:cursor-grabbing sm:min-h-[18px] ${
						base
							? "border-[1.5px] border-done text-done"
							: "border-[1.5px] border-accent text-accent"
					} ${props.dragging ? "opacity-60" : ""}`}
				>
					{base && props.phone ? "comp. base" : label}
				</button>
			)}
		</Tooltip>
	);
}

/** "PS2" for the newest patch set, else what the head is compared with. */
const latestLabel = (session: SessionInfo) => {
	const latest = session.patchsets.at(-1);
	return latest ? `PS${latest.number}` : "your snapshot";
};

/** The card's two lines: a heading and the rest. */
function Card(props: { head: ReactNode; body?: ReactNode }) {
	return (
		<span className="block max-w-72 text-left">
			<span className="block text-ink">{props.head}</span>
			{props.body !== undefined && (
				<span className="block text-muted">{props.body}</span>
			)}
		</span>
	);
}

const Sha = ({ oid }: { oid: string }) => (
	<code className="font-mono text-ink-soft">{short(oid)}</code>
);

/** A dot's details (its hover card, the phone sheet's text). */
function dotCard(dot: Dot, session: SessionInfo): ReactNode {
	switch (dot.kind) {
		case "branch":
			return (
				<Card
					head={`${dot.label} · base branch`}
					body={
						<>
							merge base <Sha oid={dot.oid} />
						</>
					}
				/>
			);
		case "patchset": {
			const p = dot.patchset as SessionInfo["patchsets"][number];
			return (
				<Card
					head={
						<>
							{dot.label} · <Sha oid={p.head} /> · started{" "}
							<RelativeTime iso={new Date(p.startedAt).toISOString()} />
						</>
					}
					body={
						<>
							against <Sha oid={p.mergeBase} />
							{p.since !== null && ` · since PS${p.since}`}
						</>
					}
				/>
			);
		}
		case "snapshot":
			return (
				<Card
					head={
						<>
							snapshot <Sha oid={dot.oid} />
						</>
					}
					body="not a patch set yet: your first mark starts it"
				/>
			);
		case "head":
			return (
				<Card
					head={
						<>
							head · <Sha oid={dot.oid} />
						</>
					}
					body={
						session.head
							? `${commitsLabel(session.head.commits, false)} since ${latestLabel(
									session,
								)}`
							: undefined
					}
				/>
			);
	}
}

/** One shape per connector between two consecutive dots. */
interface Connector {
	from: Dot;
	to: Dot;
	/**
	 * The engine's answer for the pair when one is asked for: pending until
	 * it is in (also before the first read lands), or why it failed.
	 */
	answer: RereviewAnswer | { pending: true } | { error: string } | undefined;
	/** The commit count known at once (the head's), else from the answer. */
	commits: number | null;
	/** The shape code known from the session (a patch set's record). */
	shape: Shape["code"] | null;
	dashed: boolean;
}

/** The answer once it is in; null while pending, failed or never asked. */
const settled = (a: Connector["answer"]): RereviewAnswer | null =>
	a && !("pending" in a) && !("error" in a) ? a : null;

const stubShape = (code: Shape["code"], commits: number): Shape => ({
	code,
	commits,
	identical: false,
	conflicts: [],
	virtualRebase: "ok",
	virtualHead: null,
});

/** How much the engine found to read, and the reviewed clusters gone. */
function toReadOf(answer: RereviewAnswer): ToRead {
	return {
		...answer.toRead,
		gone: answer.files.reduce(
			(n, f) => n + f.clusters.filter((c) => c.kind === "gone").length,
			0,
		),
	};
}

/** The connector's card: what happened between its dots, and what is to read. */
function ConnectorCard(props: { c: Connector; baseBranch?: string }) {
	const { c } = props;
	const head = `${c.from.label} → ${c.to.label}`;
	const answer = settled(c.answer);
	if (answer) {
		return (
			<Card
				head={head}
				body={connectorLine(answer.shape, toReadOf(answer), props.baseBranch)}
			/>
		);
	}
	if (c.answer && "error" in c.answer) {
		return (
			<Card
				head={head}
				body={
					<span className="text-bad">Couldn't compute: {c.answer.error}</span>
				}
			/>
		);
	}
	// Nothing to compute (the first patch set over the branch): the count alone.
	if (!c.answer) {
		return (
			<Card
				head={head}
				body={c.commits === null ? undefined : commitsLabel(c.commits, false)}
			/>
		);
	}
	const words =
		c.shape !== null
			? connectorLine(stubShape(c.shape, c.commits ?? 0), null)
			: c.commits !== null
				? connectorLine(stubShape("S1", c.commits), null)
				: null;
	return (
		<Card
			head={head}
			body={
				// The to-read slot: a spinner until the engine answers (principle 8).
				<span className="inline-flex items-center gap-1.5">
					{words}
					{words && " ·"}
					<Spinner
						label="Computing what changed"
						size={12}
						testId="rereview-pending"
					/>
				</span>
			}
		/>
	);
}

/** The line between two dots, its count on it, and its card on hover or focus. */
function ConnectorLine(props: {
	c: Connector;
	phone: boolean;
	baseBranch?: string;
	className?: string;
}) {
	const { c } = props;
	const answer = settled(c.answer);
	const count = c.commits ?? answer?.shape.commits ?? null;
	const tone = !c.dashed
		? "border-line-strong"
		: answer
			? {
					warn: "border-warn",
					ok: "border-ok",
					bad: "border-bad",
				}[connectorTone(answer.shape, toReadOf(answer))]
			: "border-warn";
	// The count's slot keeps its height while it loads (nothing moves).
	const label =
		count !== null ? (
			commitsLabel(count, props.phone)
		) : c.answer ? (
			<Spinner label="Counting commits" size={10} />
		) : null;
	return (
		<Tooltip
			content={<ConnectorCard c={c} baseBranch={props.baseBranch} />}
			describe={false}
			lazy
		>
			{(trigger) => (
				<span
					{...trigger}
					role="img"
					aria-label={`${c.from.label} to ${c.to.label}${count !== null ? `: ${commitsLabel(count, false)}` : ""}`}
					data-testid={`ps-conn-${c.to.id}`}
					data-tone={c.dashed ? tone.replace("border-", "") : undefined}
					// biome-ignore lint/a11y/noNoninteractiveTabindex: the card opens on focus.
					tabIndex={0}
					className={`relative mt-5 block h-3.5 min-w-0 flex-1 rounded-sm border-t-2 focus-visible:outline-2 focus-visible:outline-accent ${
						c.dashed ? "border-dashed" : ""
					} ${tone} ${props.className ?? ""}`}
				>
					{/* No slot at all without a count (the branch's connector): an
					    empty one would notch the line. */}
					{label !== null && (
						<span
							data-testid="ps-conn-label"
							className="absolute top-1.5 left-1/2 inline-flex h-4 -translate-x-1/2 items-center bg-surface px-1 text-[10.5px] whitespace-nowrap text-faint"
						>
							{label}
						</span>
					)}
				</span>
			)}
		</Tooltip>
	);
}

/**
 * On a phone a tap on a dot opens this sheet: its details, and View /
 * Compare from here, the fallback for dragging a marker.
 */
function DotSheet(props: {
	dot: Dot | null;
	session: SessionInfo;
	canView: boolean;
	canBase: boolean;
	onView: () => void;
	onBase: () => void;
	onClose: () => void;
}) {
	const dialog = useRef<HTMLDialogElement>(null);
	const open = props.dot !== null;
	useEffect(() => {
		const d = dialog.current;
		if (!d) return;
		if (open && !d.open) {
			if (typeof d.showModal === "function") d.showModal();
			else d.setAttribute("open", "");
		} else if (!open && d.open) {
			if (typeof d.close === "function") d.close();
			else d.removeAttribute("open");
		}
	}, [open]);
	const button =
		"flex min-h-10 flex-1 items-center justify-center rounded-md border border-line-strong px-3 text-sm font-semibold text-ink hover:bg-overlay focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40";
	return (
		<dialog
			ref={dialog}
			aria-label={props.dot ? `${props.dot.label} details` : "Dot details"}
			data-testid="dot-sheet"
			onClose={props.onClose}
			onClick={(event) => {
				// A click on the backdrop lands on the dialog itself.
				if (event.target === dialog.current) props.onClose();
			}}
			onKeyDown={(event) => {
				if (event.key === "Escape") props.onClose();
			}}
			className="m-0 mt-auto w-full max-w-none rounded-t-2xl border-t border-edge bg-overlay p-3 text-sm text-ink shadow-sheet backdrop:bg-canvas/70"
		>
			{props.dot && dotCard(props.dot, props.session)}
			<div className="mt-3 flex gap-2">
				<button
					type="button"
					className={button}
					disabled={!props.canView}
					onClick={props.onView}
				>
					View
				</button>
				<button
					type="button"
					className={button}
					disabled={!props.canBase}
					onClick={props.onBase}
				>
					Compare from here
				</button>
			</div>
		</dialog>
	);
}

/**
 * The patch set graph (design doc, "Patch set graph"): one rail with the
 * base branch dot, one dot per patch set of the reviewer, and a last slot
 * that is always rendered at one width (TAIL_WIDTH): "up to date" when the
 * PR's head is the newest dot, else a dashed connector with its commit
 * count and the hollow head dot (nothing below the rail moves when a push
 * arrives). Two markers set the comparison: viewing and comparison base,
 * dragged (pointer events, touch too) or moved with Ctrl+[ / Ctrl+] and
 * Ctrl+Shift+[ / Ctrl+Shift+] (qualified keys only, owner 2026-11-07).
 * Dots and connectors show a card on hover or focus; on a phone a tap on
 * a dot opens a sheet with View and Compare from here. Viewing the head
 * stores nothing (the first mark starts the patch set).
 */
export function PatchsetGraph(props: {
	session: SessionInfo;
	comparison: Comparison;
	/** The comparison's own answer (the connectors read theirs, cached alike). */
	rereview?: RereviewAnswer | { pending: true } | undefined;
	onViewHead?: () => void;
}) {
	const { session, comparison } = props;
	const phone = !useMedia(NOT_PHONE);
	const { dots, head } = railDots(session, comparison.viewing);
	const all = head ? [...dots, head] : dots;
	// The engine's answer for each connector between two patch sets (its
	// commit count is only there) and for the head's (its line and to-read
	// count; its count comes from git at once).
	const pairs = all.flatMap((to, i) => {
		const from = all[i - 1];
		if (from?.kind !== "patchset") return [];
		if (to.kind === "patchset" || to.kind === "head") return [{ from, to }];
		return [];
	});
	const answers = useQueries({
		queries: pairs.map(({ from, to }) =>
			rereviewQuery(
				from.position,
				to.kind === "head" ? { head: to.oid } : { patchset: to.position },
			),
		),
	});
	const connectors: Connector[] = all.slice(1).map((to, i) => {
		const from = all[i] as Dot;
		const at = pairs.findIndex((p) => p.from === from && p.to === to);
		return {
			from,
			to,
			answer:
				at === -1
					? undefined
					: answers[at]?.error
						? { error: answers[at].error.message }
						: (answers[at]?.data ?? { pending: true }),
			commits: to.kind === "head" && session.head ? session.head.commits : null,
			shape: to.patchset?.shape ?? null,
			dashed: to.kind === "head",
		};
	});
	const headConnector = connectors.find((c) => c.to.kind === "head") ?? null;
	const viewingPos = comparison.viewing
		? positionOf(comparison.viewing, comparison.patchsets)
		: -1;

	// Dragging a marker: which one, and the dot under the pointer.
	const [drag, setDrag] = useState<{
		kind: "viewing" | "base";
		over: string | null;
	} | null>(null);
	const rail = useRef<HTMLDivElement>(null);
	const canView = (dot: Dot) => dot.viewing !== undefined;
	const canBase = (dot: Dot) =>
		dot.base !== undefined && dot.position < viewingPos;
	const view = (dot: Dot) => {
		if (!dot.viewing) return;
		comparison.setViewing(dot.viewing);
		if (dot.kind === "head") props.onViewHead?.();
	};
	const baseOn = (dot: Dot) => {
		if (dot.base && canBase(dot)) comparison.setBase(dot.base);
	};
	/** The dot nearest to `x` among the rail's dots. */
	const dotAt = (x: number): Dot | null => {
		const root = rail.current;
		if (!root) return null;
		let best: { dot: Dot; d: number } | null = null;
		for (const el of root.querySelectorAll<HTMLElement>("[data-dot]")) {
			const r = el.getBoundingClientRect();
			const d = Math.abs(r.left + r.width / 2 - x);
			const dot = all.find((o) => o.id === el.dataset.dot);
			if (dot && (!best || d < best.d)) best = { dot, d };
		}
		return best?.dot ?? null;
	};
	const startDrag =
		(kind: "viewing" | "base") => (e: ReactPointerEvent<HTMLButtonElement>) => {
			e.preventDefault();
			const target = e.currentTarget;
			target.setPointerCapture(e.pointerId);
			setDrag({ kind, over: null });
			const allowed = (dot: Dot | null) =>
				dot && (kind === "viewing" ? canView(dot) : canBase(dot)) ? dot : null;
			const move = (ev: PointerEvent) => {
				setDrag({ kind, over: allowed(dotAt(ev.clientX))?.id ?? null });
			};
			const up = (ev: PointerEvent) => {
				target.removeEventListener("pointermove", move);
				target.removeEventListener("pointerup", up);
				target.removeEventListener("pointercancel", cancel);
				setDrag(null);
				const dot = allowed(dotAt(ev.clientX));
				if (!dot) return;
				if (kind === "viewing") view(dot);
				else baseOn(dot);
			};
			const cancel = () => {
				target.removeEventListener("pointermove", move);
				target.removeEventListener("pointerup", up);
				target.removeEventListener("pointercancel", cancel);
				setDrag(null);
			};
			target.addEventListener("pointermove", move);
			target.addEventListener("pointerup", up);
			target.addEventListener("pointercancel", cancel);
		};

	// Qualified keys only (owner, 2026-11-07): nothing moves by accident.
	const step = (kind: "viewing" | "base", dir: 1 | -1) => {
		const current =
			kind === "viewing"
				? all.find((d) => sameViewing(d.viewing, comparison.viewing))
				: all.find((d) => sameBase(d.base, comparison.base));
		if (!current) return;
		const i = all.indexOf(current);
		const next = all[i + dir];
		if (!next) return;
		if (kind === "viewing") {
			if (canView(next)) view(next);
		} else if (canBase(next)) baseOn(next);
	};
	const group = "Files changed";
	useShortcut({
		keys: "Ctrl+]",
		label: "View the next patch set (the head past the newest)",
		group,
		run: () => step("viewing", 1),
	});
	useShortcut({
		keys: "Ctrl+[",
		label: "View the previous patch set",
		group,
		run: () => step("viewing", -1),
	});
	useShortcut({
		keys: "Ctrl+Shift+]",
		label: "Move the comparison base right",
		group,
		run: () => step("base", 1),
	});
	useShortcut({
		keys: "Ctrl+Shift+[",
		label: "Move the comparison base left",
		group,
		run: () => step("base", -1),
	});

	const [sheet, setSheet] = useState<Dot | null>(null);
	const upToDate = session.head !== null && !head;

	const node = (dot: Dot) => {
		const isViewing = sameViewing(dot.viewing, comparison.viewing);
		const isBase = sameBase(dot.base, comparison.base);
		const over = drag?.over === dot.id;
		const name =
			dot.kind === "branch"
				? `${dot.label} (base branch)`
				: dot.kind === "head" || dot.kind === "snapshot"
					? `${dot.kind} ${short(dot.oid)}`
					: dot.label;
		const button = (trigger: Partial<TooltipTriggerProps> = {}) => (
			<button
				type="button"
				{...trigger}
				aria-label={name}
				data-dot={dot.id}
				data-testid={`ps-dot-${dot.id}`}
				data-viewing={isViewing || undefined}
				data-base={isBase || undefined}
				data-drop={over || undefined}
				onClick={() => {
					if (phone) setSheet(dot);
					else if (dot.kind === "branch") baseOn(dot);
					else view(dot);
				}}
				className={`flex h-10 w-10 items-center justify-center rounded-full focus-visible:outline-2 focus-visible:outline-accent ${
					over ? "bg-accent/20" : ""
				}`}
			>
				<DotGlyph dot={dot} viewing={isViewing} base={isBase} />
			</button>
		);
		return (
			<div
				key={dot.id}
				data-testid={`ps-node-${dot.id}`}
				data-kind={dot.kind}
				className="relative grid min-w-11 shrink-0 justify-items-center gap-0.5 sm:min-w-14"
			>
				<span
					className={`text-[11px] ${isViewing ? "font-semibold text-ink" : "text-muted"}`}
				>
					{dot.label}
				</span>
				{phone ? (
					button()
				) : (
					<Tooltip content={dotCard(dot, session)} describe={false} lazy>
						{(trigger) => button(trigger)}
					</Tooltip>
				)}
				{/* The markers' row keeps its height on every dot: none jumps. */}
				<span className="flex min-h-10 items-start gap-1 sm:min-h-[18px]">
					{isBase && (
						<Marker
							kind="base"
							phone={phone}
							dragging={drag?.kind === "base"}
							onPointerDown={startDrag("base")}
						/>
					)}
					{isViewing && (
						<Marker
							kind="viewing"
							phone={phone}
							dragging={drag?.kind === "viewing"}
							onPointerDown={startDrag("viewing")}
						/>
					)}
				</span>
			</div>
		);
	};

	return (
		// biome-ignore lint/a11y/useSemanticElements: a named group of dots and markers; a fieldset is for form controls.
		<div
			ref={rail}
			role="group"
			aria-label="Patch sets"
			data-testid="psrail"
			className="flex items-start overflow-x-auto px-2 pt-3 pb-1 sm:px-4"
		>
			{dots.map((dot, i) => (
				<div key={dot.id} className="contents">
					{i > 0 && (
						<ConnectorLine
							c={connectors[i - 1] as Connector}
							phone={phone}
							baseBranch={session.head?.baseBranch}
							className="min-w-[26px] basis-[26px] sm:min-w-[60px] sm:basis-[60px]"
						/>
					)}
					{node(dot)}
				</div>
			))}
			<div
				data-testid="ps-tail"
				data-state={head ? "head" : upToDate ? "up-to-date" : "none"}
				className="flex w-[84px] shrink-0 items-start sm:w-[150px]"
			>
				{head && headConnector ? (
					<>
						<ConnectorLine
							c={headConnector}
							phone={phone}
							baseBranch={session.head?.baseBranch}
						/>
						{node(head)}
					</>
				) : upToDate ? (
					<Tooltip
						content="The PR's head is this patch set: nothing new was pushed"
						describe={false}
					>
						{(trigger) => (
							<span
								{...trigger}
								role="img"
								aria-label="up to date"
								data-testid="ps-upto"
								// biome-ignore lint/a11y/noNoninteractiveTabindex: the tooltip opens on focus.
								tabIndex={0}
								className="mt-4 inline-flex items-center gap-1 rounded-sm pl-2 text-[11px] whitespace-nowrap text-ok focus-visible:outline-2 focus-visible:outline-accent"
							>
								<CheckIcon size={12} aria-hidden />
								up to date
							</span>
						)}
					</Tooltip>
				) : session.pinnedHead ? (
					<span className="mt-4 pl-2 text-[11px] text-faint">pinned</span>
				) : null}
			</div>
			{phone && (
				<DotSheet
					dot={sheet}
					session={session}
					canView={sheet ? canView(sheet) : false}
					canBase={sheet ? canBase(sheet) : false}
					onView={() => {
						if (sheet) view(sheet);
						setSheet(null);
					}}
					onBase={() => {
						if (sheet) baseOn(sheet);
						setSheet(null);
					}}
					onClose={() => setSheet(null)}
				/>
			)}
		</div>
	);
}
