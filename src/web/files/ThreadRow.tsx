import {
	AlertIcon,
	CheckCircleIcon,
	CommentDiscussionIcon,
	HistoryIcon,
} from "@primer/octicons-react";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useContext, useRef } from "react";
import type { SpanAgentThread } from "../../shared/agent";
import type { ThreadPlacement } from "../../shared/rereview/placement";
import type { DiffSide, ReviewThread } from "../../shared/types";
import { AgentThreadCard } from "../agent/AgentThreadCard";
import { AgentUnplaced } from "../agent/AgentUnplaced";
import { agentStatusQuery } from "../agent/api";
import { useLandWhere } from "../agent/pendingThread";
import { useAgentPlacing } from "../agent/placeable";
import { ThreadAgentContext, useThreadAgent } from "../agent/threadAgent";
import { Badge, LabeledIcon } from "../overview/parts";
import { Conversation } from "../threads/Conversation";
import { Avatar } from "../threads/people";
import { ThreadStatus } from "../threads/ThreadStatus";
import { useFloatClearCard } from "./floatClear";
import { StackControls } from "./stickyControls";
import {
	ChangedChip,
	ChangedSince,
	NearLink,
	NotHereNote,
	PlacementChip,
	usePlacementInfo,
} from "./ThreadFate";
import { useFocusCard } from "./threadFocus";
import {
	firstWords,
	MoveFailureLine,
	MoveHandle,
	useAgentMove,
	useMovable,
} from "./threadMove";
import type { NotHere } from "./threadPlacement";

/** A since-view NotHere with the compared patch set it is said against. */
export interface NotHereAt {
	notHere: NotHere;
	since?: number;
}

/**
 * One thread opened in Files changed: a header with its state (resolved in
 * green, unmistakably), its count and your-turn dot, outdated, and a flag
 * when its line couldn't be placed; then every comment, the reply box and
 * the Resolve button.
 */
export function ThreadBlock(props: {
	readId: string;
	thread: ReviewThread;
	/** Its line isn't in this diff: shown in the file's header instead. */
	unplaced?: boolean;
	/** The since view: why its line has no row here, and the way to it (CAR-255). */
	notHere?: NotHereAt;
	/** Resolve was pressed on it (not Unresolve), from the button `from`. */
	onResolved?: (thread: ReviewThread, from: Element) => void;
}) {
	const { thread, onResolved } = props;
	const { placements, moves } = usePlacementInfo();
	const placement = placements?.get(thread.id);
	const onToggle =
		onResolved &&
		((resolved: boolean, from: Element) => {
			if (resolved) onResolved(thread, from);
		});
	const agent = useThreadAgent(thread, { onToggle });
	// Asked for (threadFocus): in view; its agent conversation, when asked
	// for too, opens by itself (useThreadAgent).
	const card = useRef<HTMLElement>(null);
	useFocusCard(thread.id, card, undefined, {
		ready: (f) => !f.conversation || agent?.conversation?.id === f.conversation,
	});
	const ref = { source: "github" as const, id: thread.id };
	const movable = useMovable({
		thread: ref,
		commit: thread.madeOn ?? thread.commit,
		lines: thread.anchor !== null,
	});
	// Posted from a pending thread (Comment on an agent card): shown where
	// that one was.
	useLandWhere(agent?.conversation?.id, card);
	return (
		<ThreadAgentContext.Provider value={agent}>
			<article
				ref={card}
				data-thread={thread.id}
				data-testid="files-thread"
				aria-label={`${thread.resolved ? "Resolved" : "Unresolved"} thread by ${thread.author}`}
				className="min-w-0 overflow-hidden rounded-lg border border-edge bg-surface"
			>
				<div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-line bg-band px-2.5 py-1 text-xs text-muted">
					{movable && (
						<span className="-my-1 -ml-2 flex">
							<MoveHandle
								thread={ref}
								words={firstWords(thread.excerpt)}
								path={thread.path}
								avatar={
									<Avatar
										login={thread.author}
										url={thread.avatarUrl}
										size={16}
									/>
								}
							/>
						</span>
					)}
					{thread.resolved ? (
						<CheckCircleIcon
							size={14}
							aria-hidden
							className="shrink-0 text-ok"
						/>
					) : (
						<CommentDiscussionIcon
							size={14}
							aria-hidden
							className="shrink-0 text-warn"
						/>
					)}
					<span
						className={`font-semibold ${thread.resolved ? "text-ok" : "text-ink-soft"}`}
					>
						{thread.resolved ? "Resolved" : "Unresolved"}
					</span>
					{props.unplaced &&
						(props.notHere ? (
							<NotHereNote
								notHere={props.notHere.notHere}
								since={props.notHere.since}
								path={thread.path}
								resolved={thread.resolved}
								open={{ thread: thread.id }}
							/>
						) : (
							<LabeledIcon
								icon={AlertIcon}
								label="Line not in this diff"
								// A resolved thread asks for nothing: the fact, muted.
								className={thread.resolved ? "text-muted" : "text-warn"}
							/>
						))}
					<span className="ml-auto flex items-center gap-2">
						<PlacementChip thread={thread} />
						<ThreadStatus
							thread={thread}
							mark={false}
							tall={agent !== null}
							onCounter={agent?.open ? agent.close : undefined}
						/>
						{thread.outdated && (
							<Badge tone="gray" icon={HistoryIcon}>
								outdated
							</Badge>
						)}
					</span>
				</div>
				<div className="space-y-2 p-2.5">
					<MoveFailureLine thread={ref} />
					{placement?.kind === "changed" && (
						<ChangedSince
							thread={thread}
							placement={placement}
							moved={moves?.get(thread.id)}
						/>
					)}
					<Conversation
						readId={props.readId}
						thread={thread}
						onToggle={onToggle}
					/>
				</div>
			</article>
		</ThreadAgentContext.Provider>
	);
}

/**
 * Where a row's card (an opened thread, a composer) sits in the diff table:
 * across all its `columns`, or side by side under the `side` it belongs to.
 */
export type CardPlace = { columns: number } | { side: DiffSide };

/** The card's box: a conversation's font and wrapping, on the canvas. */
const CARD =
	"space-y-2 border-y border-line bg-canvas py-2 font-sans text-sm leading-normal whitespace-normal text-ink";

/**
 * A row under a line's row holding a card. Across the table (unified, and
 * side by side on a phone, where half of 360px is unreadable) its content
 * stays at the scroll container's visible width (`--diff-w`, set by
 * DiffBody) and in view however far the code scrolls sideways, the
 * cluster's rail painted down its left edge. Under one side of a
 * side-by-side row (which never scrolls sideways): the rail and controls
 * cells, then the card over that side's number and code columns and a
 * blank over the other side's, in the blank side's tone. Text wraps to the
 * card's width; wide code in a comment scrolls in the comment. Right under
 * a cluster's first row on touch, it starts 10px lower: below that row's
 * side-by-side controls' 40px targets (DiffBody's UNDER_CONTROLS); in a run
 * whose controls stack, it starts past the controls column. Either way
 * neither covers the other. The card registers with the phone's floating
 * Files button, which makes way while its controls are under it
 * (floatClear.ts).
 */
export function TailRow(props: {
	testId: string;
	id?: string;
	place: CardPlace;
	/** The cluster rail's class, carried on beside the card (the rows it sits between are one cluster). */
	rail?: string;
	children: ReactNode;
}) {
	const { place } = props;
	const floatCard = useFloatClearCard();
	// In a cluster run whose touch controls stack (StackControls), the card
	// starts past the controls column, where the stacked cross-off hangs:
	// neither covers the other, whenever the card opens, and nothing else
	// moves.
	const clear = useContext(StackControls);
	if ("columns" in place) {
		return (
			<tr
				data-testid={props.testId}
				id={props.id}
				data-clear-of-controls={clear || undefined}
			>
				<td
					colSpan={place.columns}
					className={`p-0 ${clear ? "pointer-coarse:pl-[calc(0.25rem+var(--controls-w))]" : ""}`}
				>
					<div
						ref={floatCard}
						data-tail-card=""
						className={`sticky left-0 w-[var(--diff-w,100%)] max-w-full pr-2 pl-3 pointer-coarse:[tr:has([data-sticky-slot])+tr>td>&]:mt-2.5 ${clear ? "pointer-coarse:left-[calc(0.25rem+var(--controls-w))] pointer-coarse:w-[calc(var(--diff-w,100%)-0.25rem-var(--controls-w))]" : ""} ${CARD}`}
					>
						{props.rail && (
							<span
								aria-hidden
								data-testid="thread-rail"
								className={`absolute inset-y-0 left-0 w-1 ${props.rail}`}
							/>
						)}
						{props.children}
					</div>
				</td>
			</tr>
		);
	}
	const blank = <td colSpan={2} className="bg-band" />;
	return (
		<tr data-testid={props.testId} id={props.id}>
			<td
				aria-hidden
				data-testid="thread-rail"
				className={`p-0 ${props.rail ?? ""}`}
			/>
			<td />
			{place.side === "RIGHT" && blank}
			<td colSpan={2} className="p-0">
				<div ref={floatCard} data-tail-card="" className={`px-2 ${CARD}`}>
					{props.children}
				</div>
			</td>
			{place.side === "LEFT" && blank}
		</tr>
	);
}

/** The threads of a bubble, opened under their line (TailRow). */
export function ThreadRow(props: {
	readId: string;
	threads: ReviewThread[];
	id?: string;
	place: CardPlace;
	rail?: string;
	/** Resolve was pressed on one of them (resolveCollapse.ts). */
	onResolved?: (thread: ReviewThread, from: Element) => void;
}) {
	return (
		<TailRow
			testId="thread-row"
			id={props.id}
			place={props.place}
			rail={props.rail}
		>
			{props.threads.map((t, i) => (
				<ThreadBlock
					key={t.id || `#${i}`}
					readId={props.readId}
					thread={t}
					onResolved={props.onResolved}
				/>
			))}
		</TailRow>
	);
}

/** What an agent bubble's opened threads show (AgentThreadCards). */
interface AgentCardsProps {
	threads: SpanAgentThread[];
	/** Their line isn't in this diff (the file's header). */
	unplaced?: boolean;
	/** The since view: why each one's line has no row here (CAR-255). */
	notHere?: ReadonlyMap<SpanAgentThread, NotHereAt>;
	/** Asked on an earlier head (the file's header): each card says on which. */
	outdated?: boolean;
	/** Traced and not placed in this file: each with its fate. */
	fates?: ReadonlyMap<SpanAgentThread, UnplacedPlacement>;
}

/**
 * The agent threads of an agent bubble, opened under their line, after the
 * line's comment threads. The status comes from the chip's poll.
 */
export function AgentThreadRow(
	props: AgentCardsProps & { id?: string; place: CardPlace; rail?: string },
) {
	return (
		<TailRow
			testId="agent-thread-row"
			id={props.id}
			place={props.place}
			rail={props.rail}
		>
			<AgentThreadCards
				threads={props.threads}
				unplaced={props.unplaced}
				notHere={props.notHere}
				outdated={props.outdated}
				fates={props.fates}
			/>
		</TailRow>
	);
}

/**
 * An agent bubble's opened threads, wherever they are drawn: under a line
 * (AgentThreadRow), or under a rendered block (MarkdownView).
 */
export function AgentThreadCards(props: AgentCardsProps) {
	const status = useQuery({ ...agentStatusQuery, enabled: false }).data;
	const { placements } = useAgentPlacing();
	return (
		<>
			{props.fates ? (
				<ul className="space-y-1.5">
					{props.threads.map((t) => {
						const fate = props.fates?.get(t);
						return (
							<AgentUnplaced
								key={t.id}
								thread={t}
								fate={fate?.fate ?? null}
								movedTo={fate?.movedTo}
								dropPath={fate?.path}
								link={
									fate?.nearest && (
										<NearLink
											path={fate.path}
											line={fate.nearest.line}
											side={fate.nearest.side}
										/>
									)
								}
							/>
						);
					})}
				</ul>
			) : (
				props.threads.map((t) => {
					const card = (
						<AgentLineCard
							key={t.id}
							thread={t}
							status={status}
							unplaced={props.unplaced}
							notHere={props.notHere?.get(t)}
							outdated={props.outdated ? t.anchor.commit : undefined}
						/>
					);
					const traced = placements?.get(t.id);
					return traced?.kind === "changed" ? (
						<AgentChanged key={t.id} thread={t} placement={traced}>
							{card}
						</AgentChanged>
					) : (
						card
					);
				})
			)}
		</>
	);
}

type UnplacedPlacement = Extract<ThreadPlacement, { kind: "unplaced" }>;

/** An agent thread's card on its line, with its move controls (CAR-139). */
function AgentLineCard(props: {
	thread: SpanAgentThread;
	status: Parameters<typeof AgentThreadCard>[0]["status"];
	unplaced?: boolean;
	notHere?: NotHereAt;
	outdated?: string;
}) {
	const move = useAgentMove(props.thread, props.thread.anchor.path);
	const notHere = props.notHere;
	return (
		<div className="min-w-0 space-y-1">
			<AgentThreadCard
				thread={props.thread}
				status={props.status}
				unplaced={props.unplaced}
				unplacedNote={
					props.unplaced && notHere ? (
						<NotHereNote
							notHere={notHere.notHere}
							since={notHere.since}
							path={props.thread.anchor.path}
							resolved={props.thread.resolved}
							open={{ conversation: props.thread.id }}
						/>
					) : undefined
				}
				outdated={props.outdated}
				handle={move.handle}
				moved={move.moved}
			/>
			{move.failure}
		</div>
	);
}

/** An agent thread as the placement pieces read it (a review thread's fields). */
const asThread = (t: SpanAgentThread) => ({
	createdAt: t.at,
	path: t.anchor.path,
	code: t.code ?? null,
	resolved: t.resolved,
});

/**
 * An agent thread on the lines that replaced the ones it was asked on, as
 * a review thread's card has it: the "changed since" chip, the code it
 * was asked on and the fate line; then its own card.
 */
function AgentChanged(props: {
	thread: SpanAgentThread;
	placement: Extract<ThreadPlacement, { kind: "changed" }>;
	children: ReactNode;
}) {
	const thread = asThread(props.thread);
	const { moves } = useAgentPlacing();
	return (
		<div
			data-testid="agent-changed"
			data-thread={props.thread.id}
			className="min-w-0 space-y-1.5"
		>
			<p className="flex min-h-10 items-center">
				<ChangedChip thread={thread} />
			</p>
			<ChangedSince
				thread={thread}
				placement={props.placement}
				moved={moves?.get(props.thread.id)}
			/>
			{props.children}
		</div>
	);
}
