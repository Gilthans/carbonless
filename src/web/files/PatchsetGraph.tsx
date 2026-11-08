import { AlertIcon, CheckIcon } from "@primer/octicons-react";
import { useQueries, useQuery } from "@tanstack/react-query";
import {
	type ReactNode,
	type PointerEvent as ReactPointerEvent,
	useCallback,
	useEffect,
	useId,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import { openedOn } from "../../shared/rereview/openedOn";
import type { RereviewAnswer, SessionInfo, Shape } from "../../shared/types";
import { overviewQuery, patchsetCommitsQuery, rereviewQuery } from "../api";
import { RelativeTime } from "../RelativeTime";
import { Spinner } from "../Spinner";
import { useShortcut } from "../shortcuts";
import { placeNear, Tooltip, type TooltipTriggerProps } from "../Tooltip";
import { useThreads } from "../threads/useThreads";
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
	/** The merge base it was against (its card's "Against"). */
	mergeBase?: string;
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
			mergeBase,
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

/** A marker on the rail: comparison target (accent) or comparison base (violet). */
function Marker(props: {
	kind: "viewing" | "base";
	phone: boolean;
	onPointerDown: (e: ReactPointerEvent<HTMLButtonElement>) => void;
	dragging: boolean;
}) {
	const base = props.kind === "base";
	const label = base ? "comparison base" : "comparison target";
	return (
		<Tooltip
			content={
				base
					? "Comparison base: the diff shown starts here. Drag to move it."
					: "Comparison target: the diff shown ends here. Drag to move it."
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
					{props.phone ? (base ? "comp. base" : "comp. target") : label}
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

/** A dot's card: a title, a subtitle, then one row per fact. */
function DotCardLayout(props: {
	title: string;
	subtitle: ReactNode;
	rows: ReactNode[];
}) {
	return (
		<span className="block max-w-72 text-left">
			<span className="block font-semibold text-ink">{props.title}</span>
			<span className="block text-muted">{props.subtitle}</span>
			<span className="mt-1 block text-ink-soft">
				{props.rows.map((row, i) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: fixed rows, in a fixed order.
					<span key={i} className="flex min-h-5 items-center gap-1.5">
						{row}
					</span>
				))}
			</span>
		</span>
	);
}

const plural = (n: number, word: string) =>
	`${n} ${n === 1 ? word : `${word}s`}`;

/**
 * "8 threads created (6 resolved)": the PR's threads opened while patch
 * set `number` was the newest (openedOn), from the threads the page reads
 * anyway; a spinner until they are in.
 */
function ThreadsRow(props: { number: number; session: SessionInfo }) {
	const overview = useQuery(overviewQuery);
	const { view, error } = useThreads(overview.data?.readId);
	if (!view) {
		if (error || overview.error) {
			return <span className="text-bad">Couldn't read threads</span>;
		}
		return (
			<Spinner label="Counting threads" size={12} testId="threads-pending" />
		);
	}
	const opened = view.threads.filter(
		(t) => openedOn(t.createdAt, props.session.patchsets) === props.number,
	);
	if (opened.length === 0) return <>No threads created</>;
	const resolved = opened.filter((t) => t.resolved).length;
	return (
		<>
			{plural(opened.length, "thread")} created ({resolved} resolved)
		</>
	);
}

/** "Against main at 1a2b3c4" (the merge base alone when no branch is known). */
const Against = (props: { branch?: string; oid: string }) => (
	<span>
		Against {props.branch ? `${props.branch} at ` : ""}
		<Sha oid={props.oid} />
	</span>
);

const Commit = ({ oid }: { oid: string }) => (
	<span>
		Commit <Sha oid={oid} />
	</span>
);

/** A dot's details, for a reader who doesn't know the data model. */
function DotCard(props: { dot: Dot; session: SessionInfo }) {
	const { dot, session } = props;
	const branch = session.head?.baseBranch;
	switch (dot.kind) {
		case "branch":
			return (
				<DotCardLayout
					title={dot.label}
					subtitle="Base branch"
					rows={[
						<span key="mb">
							Merge base <Sha oid={dot.oid} />
						</span>,
					]}
				/>
			);
		case "patchset": {
			const p = dot.patchset as SessionInfo["patchsets"][number];
			return (
				<DotCardLayout
					title={`Patch Set ${p.number}`}
					subtitle={
						<>
							Reviewed starting{" "}
							<RelativeTime iso={new Date(p.startedAt).toISOString()} />
						</>
					}
					rows={[
						<Commit key="c" oid={p.head} />,
						<Against key="a" branch={branch} oid={p.mergeBase} />,
						<ThreadsRow key="t" number={p.number} session={session} />,
					]}
				/>
			);
		}
		case "snapshot":
			return (
				<DotCardLayout
					title="Snapshot"
					subtitle="Not reviewed yet"
					rows={[
						<Commit key="c" oid={dot.oid} />,
						<Against key="a" branch={branch} oid={dot.mergeBase ?? dot.oid} />,
					]}
				/>
			);
		case "head":
			return (
				<DotCardLayout
					title="Head"
					subtitle="Not reviewed yet"
					rows={[
						<Commit key="c" oid={dot.oid} />,
						...(session.head
							? [
									<Against
										key="a"
										branch={branch}
										oid={session.head.mergeBase}
									/>,
									<span key="n">
										{commitsLabel(session.head.commits, false)} since{" "}
										{latestLabel(session)}
									</span>,
								]
							: []),
					]}
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
	/**
	 * The commit count known from the session (the head's; the first patch
	 * set's over the branch), else from the answer.
	 */
	commits: number | null;
	/** The session's count is still being counted (a spinner in its slot). */
	counting: boolean;
	/** Why the session's count couldn't be made (an error in its slot). */
	countError: string | null;
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
				body={
					c.commits !== null ? (
						commitsLabel(c.commits, false)
					) : c.countError !== null ? (
						<span className="text-bad">
							Couldn't count the commits: {c.countError}
						</span>
					) : c.counting ? (
						<Spinner label="Counting commits" size={12} />
					) : undefined
				}
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
		) : c.countError !== null ? (
			// Failed for good: not loading, not 0 (its card says why).
			<AlertIcon
				size={10}
				aria-hidden
				data-testid="ps-conn-count-error"
				className="text-bad"
			/>
		) : c.answer || c.counting ? (
			<Spinner label="Counting commits" size={10} testId="ps-conn-counting" />
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
					aria-label={`${c.from.label} to ${c.to.label}${count !== null ? `: ${commitsLabel(count, false)}` : c.countError !== null ? ": couldn't count the commits" : ""}`}
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
 * A dot's sticky card: opened by a click, a tap, or Enter / Space on the
 * dot; its details and the two buttons that give the dot a role. Escape,
 * a click outside, the dot again or focus leaving it closes it. Focus
 * moves into it on open (the first enabled button) and back to the dot on
 * close by Escape or a button. Fixed, kept inside the viewport.
 */
function DotPopover(props: {
	id: string;
	dot: Dot;
	session: SessionInfo;
	anchor: HTMLElement | null;
	canBase: boolean;
	canTarget: boolean;
	onBase: () => void;
	onTarget: () => void;
	/** `refocus`: give focus back to the dot. */
	onClose: (refocus: boolean) => void;
}) {
	const box = useRef<HTMLDivElement>(null);
	const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
	const { anchor, onClose } = props;
	useLayoutEffect(() => {
		const place = () => {
			const t = anchor?.getBoundingClientRect();
			const b = box.current?.getBoundingClientRect();
			if (t && b) setPos(placeNear(t, b));
		};
		place();
		window.addEventListener("scroll", place, true);
		window.addEventListener("resize", place);
		return () => {
			window.removeEventListener("scroll", place, true);
			window.removeEventListener("resize", place);
		};
	}, [anchor]);
	useEffect(() => {
		const first = box.current?.querySelector<HTMLButtonElement>(
			"button:not(:disabled)",
		);
		(first ?? box.current)?.focus();
	}, []);
	useEffect(() => {
		const onKey = (e: globalThis.KeyboardEvent) => {
			if (e.key === "Escape") onClose(true);
		};
		const onDown = (e: PointerEvent) => {
			const target = e.target as Node | null;
			if (!target) return;
			if (box.current?.contains(target) || anchor?.contains(target)) return;
			onClose(false);
		};
		window.addEventListener("keydown", onKey);
		window.addEventListener("pointerdown", onDown, true);
		return () => {
			window.removeEventListener("keydown", onKey);
			window.removeEventListener("pointerdown", onDown, true);
		};
	}, [anchor, onClose]);
	const button =
		"flex min-h-10 flex-1 items-center justify-center rounded-md border border-line-strong px-2 text-xs font-semibold whitespace-nowrap text-ink hover:bg-surface focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40 sm:min-h-8";
	return createPortal(
		<div
			ref={box}
			id={props.id}
			role="dialog"
			aria-label={`${props.dot.label} details`}
			data-testid="dot-popover"
			// Clicks on its text keep focus inside (a blur to nowhere would close it).
			tabIndex={-1}
			onBlur={(e) => {
				const next = e.relatedTarget as Node | null;
				if (next && (box.current?.contains(next) || anchor?.contains(next)))
					return;
				// Focus left for somewhere else on the page (Tab past the end).
				if (next) onClose(false);
			}}
			style={{
				left: pos?.left ?? 0,
				top: pos?.top ?? 0,
				visibility: pos ? "visible" : "hidden",
			}}
			className="fixed z-[999] w-max max-w-[min(20rem,calc(100vw-1rem))] rounded-md border border-edge bg-overlay px-2.5 py-2 text-xs leading-5 text-ink shadow-float focus:outline-none"
		>
			<DotCard dot={props.dot} session={props.session} />
			<div className="mt-2 flex gap-2">
				<button
					type="button"
					className={button}
					disabled={!props.canBase}
					onClick={props.onBase}
				>
					Comparison Base
				</button>
				<button
					type="button"
					className={button}
					disabled={!props.canTarget}
					onClick={props.onTarget}
				>
					Comparison Target
				</button>
			</div>
		</div>,
		document.body,
	);
}

/**
 * The session with each patch set's commit count filled in once the
 * server has counted it (patchsetCommitsQuery, polled only while one is
 * missing).
 */
function useWithCommits(session: SessionInfo): SessionInfo {
	const missing = session.patchsets
		.filter((p) => p.commits === null)
		.map((p) => `${p.number} ${p.head}`);
	const counted = useQuery({
		...patchsetCommitsQuery(missing),
		enabled: missing.length > 0,
	}).data;
	if (missing.length === 0 || !counted) return session;
	return {
		...session,
		patchsets: session.patchsets.map((p) => ({
			...p,
			commits: p.commits ?? counted[`${p.number} ${p.head}`] ?? null,
		})),
	};
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
 * Dots (the label and the dot, one element) and connectors show a card on
 * hover or focus. A click, a tap or Enter / Space on a dot moves nothing:
 * it makes the dot's card sticky, with Comparison Base and Comparison
 * Target, which give the dot that role (owner, 2026-11-08). Viewing the
 * head stores nothing (the first mark starts the patch set).
 */
export function PatchsetGraph(props: {
	session: SessionInfo;
	comparison: Comparison;
	/** The comparison's own answer (the connectors read theirs, cached alike). */
	rereview?: RereviewAnswer | { pending: true } | undefined;
	onViewHead?: () => void;
}) {
	const { comparison } = props;
	const session = useWithCommits(props.session);
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
			commits:
				to.kind === "head" && session.head
					? session.head.commits
					: from.kind === "branch" && typeof to.patchset?.commits === "number"
						? to.patchset.commits
						: null,
			counting:
				from.kind === "branch" &&
				to.patchset !== undefined &&
				to.patchset.commits === null,
			countError:
				from.kind === "branch" &&
				to.patchset?.commits !== null &&
				typeof to.patchset?.commits === "object"
					? to.patchset.commits.error
					: null,
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
		label: "Move the comparison target right (the head past the newest)",
		group,
		run: () => step("viewing", 1),
	});
	useShortcut({
		keys: "Ctrl+[",
		label: "Move the comparison target left",
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

	// The dot whose card is sticky (a click opened it), and its element.
	const [sticky, setSticky] = useState<string | null>(null);
	const stickyNow = useRef(sticky);
	stickyNow.current = sticky;
	const dotEls = useRef(new Map<string, HTMLButtonElement>());
	// Focus going back to a dot after its card closed shows no hover card.
	const refocusing = useRef(false);
	const closeSticky = useCallback((refocus: boolean) => {
		const el = stickyNow.current
			? dotEls.current.get(stickyNow.current)
			: undefined;
		setSticky(null);
		if (refocus && el) {
			refocusing.current = true;
			el.focus();
			refocusing.current = false;
		}
	}, []);
	const popoverId = useId();
	const upToDate = session.head !== null && !head;

	const node = (dot: Dot) => {
		const isViewing = sameViewing(dot.viewing, comparison.viewing);
		const isBase = sameBase(dot.base, comparison.base);
		const over = drag?.over === dot.id;
		const open = sticky === dot.id;
		const name =
			dot.kind === "branch"
				? `${dot.label} (base branch)`
				: dot.kind === "head" || dot.kind === "snapshot"
					? `${dot.kind} ${short(dot.oid)}`
					: dot.label;
		// The label and the dot are one element: one hover target, one
		// focus ring, one card, one click.
		const button = (trigger: TooltipTriggerProps) => (
			<button
				type="button"
				{...trigger}
				ref={(el) => {
					trigger.ref(el);
					if (el) dotEls.current.set(dot.id, el);
					else dotEls.current.delete(dot.id);
				}}
				onMouseEnter={open ? undefined : trigger.onMouseEnter}
				onFocus={(e) => {
					if (!open && !refocusing.current) trigger.onFocus(e);
				}}
				aria-label={name}
				aria-expanded={open}
				aria-haspopup="dialog"
				aria-controls={open ? popoverId : undefined}
				data-dot={dot.id}
				data-testid={`ps-dot-${dot.id}`}
				data-viewing={isViewing || undefined}
				data-base={isBase || undefined}
				data-drop={over || undefined}
				onClick={() => {
					if (open) closeSticky(false);
					else setSticky(dot.id);
				}}
				className={`grid min-w-10 justify-items-center gap-0.5 rounded-md focus-visible:outline-2 focus-visible:outline-accent ${
					over ? "bg-accent/20" : ""
				}`}
			>
				<span
					data-testid="ps-dot-label"
					className={`text-[11px] ${isViewing ? "font-semibold text-ink" : "text-muted"}`}
				>
					{dot.label}
				</span>
				<span className="flex h-10 w-10 items-center justify-center">
					<DotGlyph dot={dot} viewing={isViewing} base={isBase} />
				</span>
			</button>
		);
		return (
			<div
				key={dot.id}
				data-testid={`ps-node-${dot.id}`}
				data-kind={dot.kind}
				className="relative grid min-w-11 shrink-0 justify-items-center gap-0.5 sm:min-w-14"
			>
				<Tooltip
					content={<DotCard dot={dot} session={session} />}
					describe={false}
					lazy
					dismissKey={open}
				>
					{(trigger) => button(trigger)}
				</Tooltip>
				{open && (
					<DotPopover
						id={popoverId}
						dot={dot}
						session={session}
						anchor={dotEls.current.get(dot.id) ?? null}
						canBase={canBase(dot) && !isBase}
						canTarget={canView(dot) && !isViewing}
						onBase={() => {
							baseOn(dot);
							closeSticky(true);
						}}
						onTarget={() => {
							view(dot);
							closeSticky(true);
						}}
						onClose={closeSticky}
					/>
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
		</div>
	);
}
