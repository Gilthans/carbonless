import { PlugIcon, SparkleFillIcon, XIcon } from "@primer/octicons-react";
import { useQuery } from "@tanstack/react-query";
import {
	type KeyboardEvent,
	useCallback,
	useEffect,
	useId,
	useRef,
	useState,
} from "react";
import { Spinner } from "../../Spinner";
import { Tooltip, TooltipLayer } from "../../Tooltip";
import { NOT_PHONE, useMedia } from "../../useMedia";
import { agentStatusQuery } from "../api";
import {
	closeAgentSetup,
	type SetupTab,
	setAgentSetupTab,
	useAgentSetupOpen,
	useAgentSetupTab,
} from "../setupStore";
import { agentView } from "./agentView";
import { InviteTab } from "./InviteTab";
import { CloseButton, ErrorLine, Footer } from "./parts";
import { SpawnTab } from "./SpawnTab";
import { StatusView } from "./StatusView";

export { RELOAD_HINT } from "./parts";

/** The setup's tabs: id, icon, name. */
const TABS = [
	["invite", PlugIcon, "Invite"],
	["spawn", SparkleFillIcon, "Spawn"],
] as const;

/**
 * The reviewer's agent for this review, in one modal with two views chosen
 * by the server's status (agentView): Setup Review Agent (Invite a running
 * session over MCP, or Spawn one over ACP) while none is connected, and
 * Review Agent (its status and activity, Stop current, Detach) while one
 * is. A spinner until the status is in. A centred dialog on a desktop, a
 * bottom sheet on a phone; Escape, the backdrop and Close close it, focus
 * going back to what opened it. The page's shortcuts don't fire under it
 * (they skip `:modal`).
 */
export function AgentSetup(props: {
	open: boolean;
	onClose(): void;
	tab?: SetupTab;
	onTab?(tab: SetupTab): void;
}) {
	const { open, onClose } = props;
	const tab = props.tab ?? "invite";
	const wide = useMedia(NOT_PHONE);
	const status = useQuery({ ...agentStatusQuery, enabled: open });
	const view = agentView(status.data);
	const dialog = useRef<HTMLDialogElement | null>(null);
	const [layer, setLayer] = useState<HTMLDialogElement | null>(null);
	const setDialog = useCallback((el: HTMLDialogElement | null) => {
		dialog.current = el;
		setLayer(el);
	}, []);
	const closeButton = useRef<HTMLButtonElement | null>(null);
	const returnTo = useRef<Element | null>(null);
	const titleId = useId();
	const tabRefs = useRef<Partial<Record<SetupTab, HTMLButtonElement | null>>>(
		{},
	);
	useEffect(() => {
		const d = dialog.current;
		if (!d) return;
		if (!open) {
			if (!d.hasAttribute("open")) return;
			if (typeof d.close === "function") d.close();
			else d.removeAttribute("open");
			const back = returnTo.current;
			returnTo.current = null;
			if (back instanceof HTMLElement && back.isConnected) back.focus();
			return;
		}
		if (d.hasAttribute("open")) return;
		returnTo.current = document.activeElement;
		if (typeof d.showModal === "function") d.showModal();
		else d.setAttribute("open", "");
		closeButton.current?.focus();
	}, [open]);
	const trap = (e: KeyboardEvent<HTMLDialogElement>) => {
		if (e.key === "Escape") {
			e.preventDefault();
			onClose();
			return;
		}
		if (e.key !== "Tab") return;
		const d = dialog.current;
		if (!d) return;
		const focusable = [
			...d.querySelectorAll<HTMLElement>(
				'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
			),
		];
		const first = focusable[0];
		const last = focusable.at(-1);
		if (!first || !last) return;
		if (e.shiftKey && document.activeElement === first) {
			e.preventDefault();
			last.focus();
		} else if (!e.shiftKey && document.activeElement === last) {
			e.preventDefault();
			first.focus();
		}
	};
	const title = view === "setup" ? "Setup Review Agent" : "Review Agent";
	return (
		<dialog
			ref={setDialog}
			aria-labelledby={titleId}
			aria-busy={(open && view === "loading") || undefined}
			data-testid="agent-setup"
			data-view={open ? view : undefined}
			onCancel={(e) => {
				e.preventDefault();
				onClose();
			}}
			onKeyDown={trap}
			onClick={(e) => {
				if (e.target === dialog.current) onClose();
			}}
			className={`max-w-none overflow-hidden border-edge bg-surface p-0 text-ink backdrop:bg-canvas/70 backdrop:backdrop-blur-[2px] open:flex open:flex-col ${
				wide
					? "m-auto max-h-[85dvh] w-[min(34rem,calc(100vw-2rem))] rounded-lg border shadow-float"
					: "m-0 mt-auto max-h-[90dvh] w-full rounded-t-2xl border-t shadow-sheet"
			}`}
		>
			<TooltipLayer.Provider value={layer}>
				<div className="flex shrink-0 items-center gap-2.5 py-2 pr-1.5 pl-4 sm:pl-5">
					<SparkleFillIcon size={20} aria-hidden className="text-agent-ink" />
					<h2
						id={titleId}
						className="text-xl font-bold tracking-[-0.01em] text-ink"
					>
						{title}
					</h2>
					<Tooltip content="Close" describe={false}>
						{(trigger) => (
							<button
								{...trigger}
								ref={(el) => {
									closeButton.current = el;
									trigger.ref(el);
								}}
								type="button"
								aria-label="Close"
								onClick={onClose}
								className="ml-auto flex size-10 items-center justify-center rounded-md text-ink-soft hover:bg-overlay hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
							>
								<XIcon aria-hidden />
							</button>
						)}
					</Tooltip>
				</div>
				{open && view === "loading" && (
					<>
						<div className="flex-1 border-t border-line px-4 py-6 sm:px-5">
							{status.isError ? (
								<ErrorLine>{status.error.message}</ErrorLine>
							) : (
								<Spinner label="Loading your agent" />
							)}
						</div>
						<Footer>
							<CloseButton onClose={onClose} />
						</Footer>
					</>
				)}
				{open && view === "connected" && status.data && (
					<StatusView status={status.data} onClose={onClose} />
				)}
				{open && view === "setup" && status.data && (
					<>
						<div
							role="tablist"
							aria-label="How your agent joins"
							className="flex shrink-0 gap-1 border-b border-line px-3"
						>
							{TABS.map(([t, Icon, label]) => (
								<button
									key={t}
									type="button"
									ref={(el) => {
										tabRefs.current[t] = el;
									}}
									role="tab"
									id={`${titleId}-tab-${t}`}
									aria-controls={`${titleId}-panel-${t}`}
									aria-selected={tab === t}
									tabIndex={tab === t ? 0 : -1}
									data-testid={`agent-setup-tab-${t}`}
									onClick={() => props.onTab?.(t)}
									onKeyDown={(e) => {
										const i = TABS.findIndex(([x]) => x === t);
										const to =
											e.key === "ArrowRight"
												? TABS[(i + 1) % TABS.length]
												: e.key === "ArrowLeft"
													? TABS[(i + TABS.length - 1) % TABS.length]
													: e.key === "Home"
														? TABS[0]
														: e.key === "End"
															? TABS[TABS.length - 1]
															: undefined;
										if (!to) return;
										e.preventDefault();
										props.onTab?.(to[0]);
										tabRefs.current[to[0]]?.focus();
									}}
									className={`-mb-px flex min-h-11 items-center gap-1.5 border-b-2 px-3 text-sm font-semibold whitespace-nowrap focus-visible:outline-2 focus-visible:outline-accent ${
										tab === t
											? "border-agent-ink text-agent-ink"
											: "border-transparent text-muted hover:text-ink"
									}`}
								>
									<Icon size={16} aria-hidden />
									{label}
								</button>
							))}
						</div>
						<div
							role="tabpanel"
							id={`${titleId}-panel-${tab}`}
							aria-labelledby={`${titleId}-tab-${tab}`}
							data-testid={`agent-${tab}-tab`}
							className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-4 pt-4 pb-5 sm:px-5"
						>
							{tab === "invite" ? (
								<InviteTab status={status.data} />
							) : (
								<SpawnTab />
							)}
						</div>
						<Footer>
							<CloseButton onClose={onClose} />
						</Footer>
					</>
				)}
			</TooltipLayer.Provider>
		</dialog>
	);
}

/** The page's one agent modal, opened from anywhere (setupStore.ts). */
export function AgentSetupHost() {
	const open = useAgentSetupOpen();
	const tab = useAgentSetupTab();
	return (
		<AgentSetup
			open={open}
			onClose={closeAgentSetup}
			tab={tab}
			onTab={setAgentSetupTab}
		/>
	);
}
