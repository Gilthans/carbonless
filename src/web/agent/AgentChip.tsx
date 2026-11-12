import { PlugIcon, SparkleFillIcon } from "@primer/octicons-react";
import {
	type QueryClient,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import type { AgentStatus } from "../../shared/agent";
import { ApiError, overviewQuery } from "../api";
import { plural } from "../overview/parts";
import { RelativeTime } from "../RelativeTime";
import { Spinner, SpinnerIcon } from "../Spinner";
import { Tooltip } from "../Tooltip";
import { NOT_PHONE, useMedia } from "../useMedia";
import {
	agentStatusQuery,
	agentThreadsQuery,
	postAgentDisconnect,
	postAgentStart,
	useAgentOn,
} from "./api";
import { openAgentSetup, openInviteSetup } from "./setupStore";

/** The status dot's colour: muted off or elsewhere, yellow on its way or busy, green ready, red failing. */
export function agentDot(status: AgentStatus): string {
	if (status.state === "error" || status.error) return "bg-bad";
	if (status.state === "ready") return "bg-ok";
	if (
		status.state === "starting" ||
		status.state === "busy" ||
		status.state === "reconnecting"
	)
		return "bg-warn";
	return "bg-unreviewed";
}

/** What the chip's tooltip says of the status. */
export function agentTip(status: AgentStatus): string {
	const who = status.agent
		? `${status.agent.name}${status.agent.version ? ` ${status.agent.version}` : ""}`
		: "";
	if (status.error) return status.error;
	if (status.via === "mcp" && status.joined) {
		const name = status.joined.name;
		if (status.state === "busy") return `${name} · answering`;
		if (status.state === "reconnecting") return `${name} · reconnecting`;
		return `${name} · listening`;
	}
	switch (status.state) {
		case "off":
			return status.configured
				? "No agent · spawn or invite"
				: "No agent · set one up";
		case "starting":
			return who ? `${who} · starting` : "Starting";
		case "busy": {
			const n = Math.max(1, status.waiting);
			const doing = `answering ${plural(n, "thread")}`;
			return who ? `${who} · ${doing}` : doing;
		}
		case "elsewhere":
			return status.elsewhere
				? `answered by the server on :${status.elsewhere}`
				: "answered by another server";
		case "error":
			return "The agent failed";
		case "reconnecting":
			return who ? `${who} · reconnecting` : "Reconnecting";
		default:
			return who || "Ready";
	}
}

/**
 * Keeps the agent threads in step with the status: whenever its state
 * (or when it last changed), the thread being answered or the waiting count
 * moves, the threads are read again (a reply landed, a question was taken
 * up).
 */
export function useAgentSync(
	client: QueryClient,
	status: AgentStatus | undefined,
): void {
	// `since` moves on every state change: a turn that began and ended
	// between two polls still shows.
	const key = status
		? `${status.state}|${status.since}|${status.answering?.thread ?? ""}|${status.waiting}`
		: "";
	const last = useRef(key);
	useEffect(() => {
		if (!key || key === last.current) return;
		const first = last.current === "";
		last.current = key;
		if (first) return;
		void client.invalidateQueries({
			queryKey: agentThreadsQuery.queryKey,
			exact: true,
		});
	}, [key, client]);
}

/** Whether pressing the chip opens its popover (else the setup). */
export const chipPopover = (status: AgentStatus | undefined): boolean =>
	Boolean(status?.joined || status?.spawned);

/** A joined session's presence, as a word. */
const presenceWord = (status: AgentStatus): string =>
	status.state === "busy"
		? "answering"
		: status.state === "reconnecting"
			? "reconnecting"
			: "listening";

const POP_BUTTON =
	"flex h-10 items-center justify-center gap-1.5 rounded-md px-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-60";

/**
 * The chip's popover: a joined session (name, machine and harness, its
 * presence and since when, Disconnect), or with nothing joined and the ACP
 * buddy off, Start (with a config) and the way to join from a session.
 */
function ChipPanel(props: { status: AgentStatus; onDone(): void }) {
	const { status, onDone } = props;
	const client = useQueryClient();
	const refresh = () =>
		client.invalidateQueries({ queryKey: agentStatusQuery.queryKey });
	const disconnect = useMutation({
		mutationFn: postAgentDisconnect,
		onSuccess: () => {
			void refresh();
			onDone();
		},
	});
	const start = useMutation({
		mutationFn: postAgentStart,
		onSuccess: () => {
			void refresh();
			onDone();
		},
	});
	const error = disconnect.error ?? start.error;
	// One write per press: set at once, before any re-render.
	const inFlight = useRef(false);
	const once = (run: (opts: { onSettled(): void }) => void) => () => {
		if (inFlight.current) return;
		inFlight.current = true;
		run({
			onSettled: () => {
				inFlight.current = false;
			},
		});
	};
	const joined = status.joined;
	return (
		<div className="grid min-w-0 gap-2 text-sm">
			{joined ? (
				<>
					<div className="flex min-w-0 items-center gap-1.5">
						<PlugIcon
							size={16}
							aria-hidden
							className="shrink-0 text-agent-ink"
						/>
						<b
							data-testid="agent-pop-name"
							className="min-w-0 truncate font-semibold text-ink"
						>
							{joined.name}
						</b>
					</div>
					<div className="min-w-0 truncate text-muted">
						{joined.harness
							? `${joined.machine} · ${joined.harness}`
							: joined.machine}
					</div>
					<div className="flex min-w-0 flex-wrap items-center gap-1.5 text-muted">
						<span
							aria-hidden
							className={`h-2 w-2 shrink-0 rounded-full ${agentDot(status)}`}
						/>
						<span data-testid="agent-pop-presence">{presenceWord(status)}</span>
						· joined <RelativeTime iso={joined.since} />
					</div>
					<button
						type="button"
						data-testid="agent-disconnect"
						disabled={disconnect.isPending}
						onClick={once((o) => disconnect.mutate(undefined, o))}
						className={`${POP_BUTTON} border border-bad text-bad hover:bg-bad/10`}
					>
						{disconnect.isPending ? (
							<Spinner label="Disconnecting" size={14}>
								Disconnect
							</Spinner>
						) : (
							"Disconnect"
						)}
					</button>
				</>
			) : (
				<>
					{!status.configured && (
						<button
							type="button"
							onClick={() => {
								onDone();
								openAgentSetup();
							}}
							className={`${POP_BUTTON} border border-agent-edge bg-agent text-agent-ink hover:text-ink`}
						>
							<SparkleFillIcon size={16} aria-hidden />
							Set up an agent
						</button>
					)}
					{status.configured && (
						<button
							type="button"
							data-testid="agent-start"
							disabled={start.isPending}
							onClick={once((o) => start.mutate(undefined, o))}
							className={`${POP_BUTTON} border border-agent-edge bg-agent text-agent-ink hover:text-ink`}
						>
							{start.isPending ? (
								<Spinner label="Starting" size={14} />
							) : (
								<SparkleFillIcon size={16} aria-hidden />
							)}
							Start
						</button>
					)}
					<button
						type="button"
						data-testid="agent-join-setup"
						onClick={() => {
							onDone();
							openInviteSetup();
						}}
						className={`${POP_BUTTON} border border-line-strong text-ink-soft hover:bg-overlay hover:text-ink`}
					>
						<PlugIcon size={16} aria-hidden />
						Join from a session
					</button>
				</>
			)}
			{error && (
				<p role="alert" className="text-xs break-words text-bad">
					{error.message}
				</p>
			)}
		</div>
	);
}

/** The chip's icon colour: the status dot's, as text (agentDot). */
export function agentInk(status: AgentStatus): string {
	switch (agentDot(status)) {
		case "bg-bad":
			return "text-bad";
		case "bg-ok":
			return "text-ok";
		case "bg-warn":
			return "text-warn";
		default:
			return "text-unreviewed";
	}
}

/** The chip's one size, wherever it is (and the space kept for it). */
export const CHIP_BOX = "flex h-10 w-7 shrink-0 items-center justify-center";

/**
 * The chip's face, a bordered circle filling the box's width (a control's
 * outline, line-strong), so it reads as a button; its icon or spinner
 * (CHIP_ICON px) inside.
 */
const CHIP_FACE =
	"flex h-7 w-7 items-center justify-center rounded-full border border-line-strong bg-raised";
const CHIP_ICON = 18;

/**
 * Whether the header keeps a place for the chip: from the first paint
 * (the overview, which says whether there is an agent, still on its way),
 * until known to have none (as of a cutoff, --viewer, no agent).
 */
export function useAgentChipPlace(asOf: boolean): boolean {
	const overview = useQuery({ ...overviewQuery, enabled: false });
	const on = overview.data?.writes === "on";
	// Reads what the chip read; never asks itself (no chip, no read).
	const status = useQuery({ ...agentStatusQuery, enabled: false });
	if (asOf) return false;
	if (overview.data && !on) return false;
	return !(status.error instanceof ApiError && status.error.status === 404);
}

/**
 * The reviewer's agent in the header, by the logo (in the sticky row,
 * beside the compact mark, once scrolled): the sparkle alone, coloured by
 * its status, in a bordered circle; the name and detail in the tooltip.
 * One size in every state (CHIP_BOX); a plug badge on the circle for a
 * session joined through MCP. Pressing it opens the agent setup, or, with
 * a joined session or the ACP buddy off, a popover (a bottom sheet on a
 * phone). Until the
 * overview says whether there is an agent, and on its first read, a
 * spinner in the icon's place; a routine poll changes nothing unless the
 * answer does. None where the review has no agent (--viewer, --as-of).
 */
export function AgentChip({
	dismissKey,
	asOf = false,
}: {
	/** Closes the tooltip whenever it changes (the chip moved). */
	dismissKey?: unknown;
	/** As of a cutoff (the session says): no agent, no place for one. */
	asOf?: boolean;
} = {}) {
	const client = useQueryClient();
	const on = useAgentOn();
	const status = useQuery({ ...agentStatusQuery, enabled: on });
	const place = useAgentChipPlace(asOf);
	useAgentSync(client, status.data);
	const phone = !useMedia(NOT_PHONE);
	const [open, setOpen] = useState(false);
	const wrapper = useRef<HTMLSpanElement>(null);
	const button = useRef<HTMLButtonElement | null>(null);
	const dialog = useRef<HTMLDialogElement>(null);
	const titleId = useId();
	const data = status.data;
	const popover = chipPopover(data);
	const shown = open && popover;
	useEffect(() => {
		const d = dialog.current;
		if (!d) return;
		if (d.open) {
			if (typeof d.close === "function") d.close();
			else d.removeAttribute("open");
		}
		if (!shown) return;
		if (phone && typeof d.showModal === "function") d.showModal();
		else if (typeof d.show === "function") d.show();
		else d.setAttribute("open", "");
		d.querySelector<HTMLElement>("button")?.focus();
	}, [shown, phone]);
	useEffect(() => {
		if (!shown || phone) return;
		const outside = (event: Event) => {
			if (!wrapper.current?.contains(event.target as Node)) setOpen(false);
		};
		const onEscape = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			setOpen(false);
			button.current?.focus();
		};
		document.addEventListener("pointerdown", outside);
		document.addEventListener("focusin", outside);
		document.addEventListener("keydown", onEscape);
		return () => {
			document.removeEventListener("pointerdown", outside);
			document.removeEventListener("focusin", outside);
			document.removeEventListener("keydown", onEscape);
		};
	}, [shown, phone]);
	if (!place) return null;
	if (!on) {
		// Whether there is an agent isn't known yet: its place, spinning.
		return (
			<span
				aria-hidden
				data-chip-space
				data-testid="agent-chip-pending"
				className={CHIP_BOX}
			>
				<span className={CHIP_FACE}>
					<SpinnerIcon size={CHIP_ICON} className="text-muted" />
				</span>
			</span>
		);
	}
	const tip = data
		? agentTip(data)
		: status.error
			? status.error.message
			: "Loading your agent";
	const joined = data?.via === "mcp" && Boolean(data.joined);
	const close = () => {
		setOpen(false);
		button.current?.focus();
	};
	return (
		<span ref={wrapper} className="relative inline-flex">
			<Tooltip content={tip} describe={false} dismissKey={dismissKey}>
				{(trigger) => (
					<button
						type="button"
						{...trigger}
						ref={(el) => {
							button.current = el;
							trigger.ref(el);
						}}
						data-testid="agent-chip"
						data-state={data?.state}
						data-via={data?.via}
						aria-label={`Your agent: ${tip}`}
						aria-busy={status.isPending || undefined}
						aria-haspopup={popover ? "dialog" : undefined}
						aria-expanded={popover ? shown : undefined}
						onClick={() => {
							if (popover) setOpen((o) => !o);
							else openAgentSetup();
						}}
						className={`group ${CHIP_BOX} rounded-full focus-visible:outline-2 focus-visible:outline-accent`}
					>
						<span
							data-testid="agent-chip-face"
							className={`relative ${
								joined
									? CHIP_FACE.replace("border-line-strong", "border-agent-edge")
									: CHIP_FACE
							} group-hover:bg-overlay`}
						>
							{status.isPending ? (
								<span data-testid="agent-chip-loading" className="flex">
									<SpinnerIcon size={CHIP_ICON} className="text-muted" />
								</span>
							) : (
								<span
									data-testid="agent-chip-icon"
									className={`flex ${data ? agentInk(data) : "text-bad"}`}
								>
									<SparkleFillIcon size={CHIP_ICON} aria-hidden />
								</span>
							)}
							{joined && (
								<span
									aria-hidden
									data-testid="agent-chip-plug"
									className="absolute -right-1 -bottom-1 flex rounded-full border border-agent-edge bg-agent p-px text-agent-ink"
								>
									<PlugIcon size={10} />
								</span>
							)}
						</span>
					</button>
				)}
			</Tooltip>
			{popover && data && (
				<dialog
					ref={dialog}
					aria-labelledby={titleId}
					data-testid="agent-popover"
					onClose={() => setOpen(false)}
					onCancel={(event) => {
						event.preventDefault();
						close();
					}}
					onKeyDown={(event) => {
						// The popover's Escape is the document's (above).
						if (phone && event.key === "Escape") {
							event.preventDefault();
							close();
						}
					}}
					onClick={(event) => {
						// A click on the sheet's backdrop lands on the dialog itself.
						if (phone && event.target === dialog.current) close();
					}}
					className={
						phone
							? "m-0 mt-auto max-h-[85dvh] w-full max-w-none rounded-t-2xl border-t border-edge bg-surface p-0 text-ink shadow-sheet backdrop:bg-canvas/70 backdrop:backdrop-blur-[2px]"
							: "absolute top-full left-0 z-40 m-0 mt-1 w-72 rounded-lg border border-edge bg-surface p-0 text-ink shadow-float"
					}
				>
					<h2 id={titleId} className="sr-only">
						Your agent
					</h2>
					<div className={phone ? "px-4 pt-3 pb-6" : "p-3"}>
						{shown && <ChipPanel status={data} onDone={close} />}
					</div>
				</dialog>
			)}
		</span>
	);
}
