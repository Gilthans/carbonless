import {
	AlertIcon,
	PulseIcon,
	SparkleFillIcon,
	SquareFillIcon,
	XIcon,
} from "@primer/octicons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	type KeyboardEvent,
	type MouseEvent,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { type AgentThread, MAX_AGENT_TEXT } from "../../shared/agent";
import { sessionQuery } from "../api";
import { Spinner } from "../Spinner";
import { useShortcut } from "../shortcuts";
import { Tooltip } from "../Tooltip";
import { newClientId } from "../threads/newThreads";
import { NOT_PHONE, useMedia } from "../useMedia";
import { chipOpensDrawer, pressAgentChip } from "./AgentChip";
import { AgentMessageItems, agentName, useAnswering } from "./AgentThreadCard";
import { askReview, replyAgent, useAgentWrites } from "./agentWrites";
import { agentStatusQuery, postAgentCancel, useAgentOn } from "./api";
import {
	closeReviewDrawer,
	isReviewDrawerOpen,
	toggleReviewDrawer,
	useReviewDrawerOpen,
} from "./drawerStore";
import { useReviewConversation } from "./reviewConversation";
import { openAgentSetup } from "./setupStore";
import {
	unseenMessages,
	useAgentDraft,
	useAgentThreadsFailed,
	useDrawerSendView,
	useSeenWriter,
} from "./threadAgent";

/** From here up the drawer pushes the page narrower; below, it overlays (a phone: full screen). */
export const DRAWER_PUSH = "(min-width: 1024px)";
/** The drawer's width beside the page (desktop). */
export const DRAWER_WIDTH = "clamp(360px, 40vw, 480px)";
/** The draft store's key for the review conversation's composer (no GitHub thread id looks like it). */
const DRAFT_KEY = ":review";
/** The shortcut that toggles the drawer. */
export const DRAWER_KEYS = "Shift+a";

/** Stands in for a conversation not opened yet (useAnswering wants one). */
const NONE: AgentThread = {
	id: "",
	anchor: { subject: "review" },
	openedBy: "human",
	at: "",
	messages: [],
	resolved: false,
	waiting: false,
	unread: false,
};

/** Links in an answer that lead to the code or another conversation: a phone's drawer gives way to them. */
const LEADS_AWAY =
	'a[data-testid="agent-code-link"], a[data-testid="agent-conversation-link"], [data-testid="agent-re-go"]:not([aria-disabled]), [data-testid="agent-started-item"]';

const ICON_BUTTON =
	"flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-ink-soft hover:bg-overlay hover:text-ink focus-visible:outline-2 focus-visible:outline-accent";

/**
 * Whether the drawer takes its width from the page (open, on a wide
 * desktop): App narrows the page, header included, by DRAWER_WIDTH.
 */
export function useDrawerPush(): boolean {
	return useDrawerMode() === "push";
}

/**
 * Where the page's pinned top (the join and find bars, the header, as
 * much of it as is on screen) ends: an overlaid drawer starts below it, so
 * the chip, Refresh, Settings and Find stay in reach. Followed on scroll
 * and resize, once a frame.
 */
function usePinnedTop(
	on: boolean,
	panel: React.RefObject<HTMLElement | null>,
): void {
	useLayoutEffect(() => {
		const el = panel.current;
		if (!on || !el) return;
		let frame = 0;
		// Straight onto the element: no render per scroll frame, never a frame late.
		const measure = () => {
			frame = 0;
			let b = 0;
			for (const pinned of document.querySelectorAll<HTMLElement>(
				"[data-pinned-top], [data-app-header]",
			)) {
				if (pinned.hidden) continue;
				b = Math.max(b, pinned.getBoundingClientRect().bottom);
			}
			const top = `${Math.max(0, Math.round(b))}px`;
			if (el.style.top !== top) el.style.top = top;
		};
		const schedule = () => {
			if (!frame) frame = requestAnimationFrame(measure);
		};
		measure();
		window.addEventListener("scroll", schedule, { passive: true });
		window.addEventListener("resize", schedule);
		const observer =
			typeof ResizeObserver === "undefined"
				? null
				: new ResizeObserver(schedule);
		for (const pinned of document.querySelectorAll(
			"[data-pinned-top], [data-app-header]",
		)) {
			observer?.observe(pinned);
		}
		return () => {
			cancelAnimationFrame(frame);
			window.removeEventListener("scroll", schedule);
			window.removeEventListener("resize", schedule);
			observer?.disconnect();
			el.style.removeProperty("top");
		};
	}, [on, panel]);
}

function useDrawerMode(): "push" | "overlay" | "phone" | null {
	const open = useReviewDrawerOpen();
	const on = useAgentOn();
	const wide = useMedia(DRAWER_PUSH);
	const desktop = useMedia(NOT_PHONE);
	const mode =
		!open || !on ? null : wide ? "push" : desktop ? "overlay" : "phone";
	const docked = mode === "push" || mode === "overlay";
	// Fixed things on the right (toasts, notices, the Files button) keep clear of it.
	useEffect(() => {
		if (!docked) return;
		const root = document.documentElement;
		root.style.setProperty("--drawer-push", DRAWER_WIDTH);
		return () => {
			root.style.removeProperty("--drawer-push");
		};
	}, [docked]);
	return mode;
}

const focusChip = () =>
	document.querySelector<HTMLElement>('[data-testid="agent-chip"]')?.focus();

/**
 * The review conversation (the one agent conversation about the whole
 * review), from the header chip: docked on the right at full height on a
 * desktop (pushing the page on a wide one, over it below DRAWER_PUSH),
 * full screen on a phone. Its header: the sparkle, "Whole review", the
 * message count, the agent status (the Your agent modal) and Close. Its
 * body: the messages as the thread conversations show them, the "new"
 * rule above unread answers (opened there, else at the end), the turn
 * under way with Stop. Then the composer, which sends the comparison
 * Files changed shows. While the agent threads are read, a spinner; a
 * failed read, an error with Retry; an empty conversation, the composer
 * alone, focused. Escape, Close or the chip close it, focus back on the
 * chip. It opens only on the reviewer's tap or key.
 */
export function ReviewConversationDrawer() {
	const open = useReviewDrawerOpen();
	const on = useAgentOn();
	const status = useQuery({ ...agentStatusQuery, enabled: false });
	const opensDrawer = chipOpensDrawer(status.data);
	useShortcut({
		keys: DRAWER_KEYS,
		label: "Whole review conversation",
		group: "Global",
		when: () => on,
		run: (e) => {
			e.preventDefault();
			if (!isReviewDrawerOpen() && (status.isPending || !opensDrawer)) {
				// The chip's press: the setup, or held for the first status read.
				pressAgentChip(status.data, status.isPending);
				return;
			}
			// Closed from inside: focus goes back to the chip, as Close does.
			const inside = document
				.getElementById("review-conversation")
				?.contains(document.activeElement);
			toggleReviewDrawer();
			if (inside) focusChip();
		},
	});
	// Never outlives its review: leaving it (App unmounts) or another
	// review (App keys this by the review) closes it, so coming back never
	// opens it, or takes focus, by itself.
	useEffect(() => () => closeReviewDrawer(), []);
	if (!open || !on) return null;
	return <Drawer />;
}

function Drawer() {
	const client = useQueryClient();
	const phone = !useMedia(NOT_PHONE);
	const push = useMedia(DRAWER_PUSH);
	// Over the page (a narrower desktop): below its pinned top, never over the header's buttons.
	const panel = useRef<HTMLElement>(null);
	usePinnedTop(!phone && !push, panel);
	const status = useQuery({ ...agentStatusQuery, enabled: false }).data;
	const viewer =
		useQuery({ ...sessionQuery, enabled: false }).data?.viewer ?? "you";
	const { thread, loading, failed } = useReviewConversation();
	const { retry } = useAgentThreadsFailed();
	const turn = useAnswering(thread ?? NONE, status);
	const answering = thread ? turn : undefined;
	const writes = useAgentWrites();
	const pending = [...writes.pending.entries()].filter(
		([, w]) =>
			(w.review === true && w.thread === undefined) ||
			(thread !== undefined && w.thread === thread.id),
	);
	const stop = useMutation({
		mutationFn: postAgentCancel,
		onSettled: () =>
			client.invalidateQueries({ queryKey: agentStatusQuery.queryKey }),
	});
	const scroller = useRef<HTMLDivElement>(null);
	const box = useRef<HTMLTextAreaElement>(null);
	useSeenWriter(thread, true, scroller);
	// The first answer unseen as it opened: the rule stays there.
	const [divider, setDivider] = useState<string | undefined>(undefined);
	const firstUnseen = thread?.unread
		? unseenMessages(thread)[0]?.id
		: undefined;
	useEffect(() => {
		if (firstUnseen) setDivider((d) => d ?? firstUnseen);
	}, [firstUnseen]);
	// Opened at the rule, once it shows (else at the end: the list is reversed).
	const scrolledTo = useRef<string | undefined>(undefined);
	useLayoutEffect(() => {
		if (!divider || scrolledTo.current === divider) return;
		const rule = scroller.current?.querySelector<HTMLElement>(
			'[data-testid="agent-new-divider"]',
		);
		if (!rule) return;
		scrolledTo.current = divider;
		rule.scrollIntoView?.({ block: "start" });
	});
	const empty = !loading && !failed && (thread?.messages.length ?? 0) === 0;
	// Focus comes in on open: the composer of an empty conversation, else
	// the drawer itself (no keyboard popping up over the answers).
	const focused = useRef<"panel" | "composer" | null>(null);
	useEffect(() => {
		if (empty && pending.length === 0 && focused.current !== "composer") {
			focused.current = "composer";
			box.current?.focus({ preventScroll: true });
		} else if (focused.current === null) {
			focused.current = "panel";
			panel.current?.focus({ preventScroll: true });
		}
	}, [empty, pending.length]);
	const close = () => {
		closeReviewDrawer();
		focusChip();
	};
	const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
		if (e.defaultPrevented) return;
		if (e.key === "Escape") {
			e.preventDefault();
			close();
			return;
		}
		// A phone's drawer is modal: Tab keeps to it.
		if (e.key !== "Tab" || !phone) return;
		const focusable = [
			...(panel.current?.querySelectorAll<HTMLElement>(
				'button:not([disabled]), textarea:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
			) ?? []),
		];
		const first = focusable[0];
		const last = focusable.at(-1);
		if (!first || !last) return;
		const at = document.activeElement;
		if (e.shiftKey && (at === first || at === panel.current)) {
			e.preventDefault();
			last.focus();
		} else if (!e.shiftKey && at === last) {
			e.preventDefault();
			first.focus();
		}
	};
	// A phone's full-screen drawer gives way to the code or conversation a link leads to.
	const onClick = (e: MouseEvent<HTMLElement>) => {
		if (!phone) return;
		if ((e.target as Element | null)?.closest?.(LEADS_AWAY)) {
			closeReviewDrawer();
		}
	};
	const count = thread?.messages.length ?? 0;
	return (
		<aside
			ref={panel}
			id="review-conversation"
			data-testid="review-conversation"
			data-mode={phone ? "phone" : push ? "push" : "overlay"}
			{...(phone
				? { role: "dialog", "aria-modal": true }
				: { role: "complementary" })}
			aria-label="Whole review conversation"
			tabIndex={-1}
			onKeyDown={onKeyDown}
			style={phone ? undefined : { width: DRAWER_WIDTH }}
			className={`fixed z-40 flex flex-col bg-surface outline-none ${
				phone
					? "inset-0"
					: `inset-y-0 right-0 border-l border-agent-edge ${push ? "" : "shadow-float"}`
			}`}
		>
			<div className="flex h-14 shrink-0 items-center gap-2 border-b border-line bg-band pr-2 pl-4">
				<SparkleFillIcon
					size={18}
					aria-hidden
					className="shrink-0 text-agent-ink"
				/>
				<h2 className="font-semibold text-ink">Whole review</h2>
				{count > 0 && (
					<span
						data-testid="review-conversation-count"
						className="text-sm text-agent-ink tabular-nums"
					>
						{count}
						<span className="sr-only">
							{count === 1 ? " message" : " messages"}
						</span>
					</span>
				)}
				<Tooltip content="Agent status" describe={false}>
					{(trigger) => (
						<button
							type="button"
							{...trigger}
							aria-label="Agent status"
							data-testid="review-conversation-status"
							onClick={() => {
								// A phone shows one layer at a time: the modal takes the drawer's place.
								if (phone) closeReviewDrawer();
								openAgentSetup();
							}}
							className={`ml-auto ${ICON_BUTTON}`}
						>
							<PulseIcon size={18} aria-hidden />
						</button>
					)}
				</Tooltip>
				<Tooltip content="Close" describe={false}>
					{(trigger) => (
						<button
							type="button"
							{...trigger}
							aria-label="Close"
							onClick={close}
							className={ICON_BUTTON}
						>
							<XIcon size={16} aria-hidden />
						</button>
					)}
				</Tooltip>
			</div>
			{/* The latest message first in the DOM's reverse: opened at the end. */}
			{/* biome-ignore lint/a11y/noStaticElementInteractions: a delegated listener for the links inside. */}
			{/* biome-ignore lint/a11y/useKeyWithClickEvents: the links handle their own keys. */}
			<div
				ref={scroller}
				data-testid="review-conversation-scroll"
				onClick={onClick}
				className="flex min-h-0 flex-1 flex-col-reverse overflow-y-auto overscroll-contain px-4 py-3"
			>
				{loading ? (
					<div
						data-testid="review-conversation-loading"
						aria-busy="true"
						className="flex flex-1 items-center justify-center"
					>
						<Spinner label="Loading the conversation" size={24} />
					</div>
				) : failed ? (
					<p
						role="alert"
						className="flex flex-wrap items-center gap-2 text-sm text-bad"
					>
						<AlertIcon size={14} aria-hidden />
						Couldn't read the conversation
						<button
							type="button"
							onClick={retry}
							className="flex h-10 items-center rounded-md px-3 font-medium text-link hover:bg-overlay focus-visible:outline-2 focus-visible:outline-accent"
						>
							Retry
						</button>
					</p>
				) : (
					<div className="space-y-3">
						<AgentMessageItems
							thread={thread}
							status={status}
							answering={answering}
							viewer={viewer}
							name={agentName(thread ?? NONE, status)}
							pending={pending}
							divider={divider}
							stop={
								<button
									type="button"
									data-testid="agent-stop"
									disabled={stop.isPending}
									onClick={() => stop.mutate()}
									className="ml-auto flex h-10 items-center gap-1.5 rounded-md border border-line-strong px-3 text-sm font-medium text-ink-soft hover:bg-overlay hover:text-ink focus-visible:outline-2 focus-visible:outline-accent disabled:text-faint"
								>
									<SquareFillIcon size={12} aria-hidden />
									Stop
								</button>
							}
						/>
					</div>
				)}
			</div>
			{!loading && !failed && <Composer thread={thread} box={box} />}
		</aside>
	);
}

const bytes = (t: string) => new TextEncoder().encode(t).length;

/**
 * "Ask agent…": Ctrl/Cmd+Enter or the sparkle sends. Its text is a draft
 * (kept while the drawer closes); sent, the box empties at once and the
 * message shows on its way (refused: why, Retry, Discard), never back in
 * the box, so a resend can't send it twice.
 */
function Composer(props: {
	thread: AgentThread | undefined;
	box: React.RefObject<HTMLTextAreaElement | null>;
}) {
	const client = useQueryClient();
	const [text, setText] = useAgentDraft(DRAFT_KEY);
	const view = useDrawerSendView();
	const { box } = props;
	const tooLong = bytes(text) > MAX_AGENT_TEXT;
	const blank = !text.trim();
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-measured as the text changes.
	useLayoutEffect(() => {
		const el = box.current;
		if (!el) return;
		el.style.height = "auto";
		el.style.height = `${el.scrollHeight + 2}px`;
	}, [text]);
	const send = () => {
		if (blank || tooLong) return;
		if (props.thread) {
			replyAgent(client, props.thread.id, text, newClientId(), view);
		} else {
			// Its state shows from the write itself (useAgentWrites), not
			// from this promise: a refusal stays on the item until Retry.
			void askReview(client, text, newClientId(), view);
		}
		setText("");
	};
	const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
		if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
			e.preventDefault();
			send();
		}
	};
	return (
		<div className="flex shrink-0 items-end gap-2 border-t border-line px-4 pt-3 pb-4">
			<textarea
				ref={box}
				aria-label="Ask agent"
				placeholder="Ask agent…"
				rows={2}
				value={text}
				onChange={(e) => setText(e.target.value)}
				onKeyDown={onKeyDown}
				className="block max-h-60 min-h-16 w-full min-w-0 flex-1 resize-none rounded-md border border-agent-edge bg-raised px-3 py-2 text-sm leading-normal text-ink placeholder:text-faint focus-visible:border-accent focus-visible:outline-2 focus-visible:outline-accent"
			/>
			<Tooltip content="Send to agent" describe={false}>
				{(trigger) => (
					<button
						type="button"
						{...trigger}
						aria-label="Send to agent"
						disabled={blank || tooLong}
						onClick={send}
						onMouseDown={(e) => e.preventDefault()}
						className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-agent-ink hover:bg-overlay focus-visible:outline-2 focus-visible:outline-accent disabled:text-faint disabled:hover:bg-transparent"
					>
						<SparkleFillIcon size={18} aria-hidden />
					</button>
				)}
			</Tooltip>
		</div>
	);
}
