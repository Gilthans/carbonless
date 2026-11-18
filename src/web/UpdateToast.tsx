import {
	AlertIcon,
	CheckCircleIcon,
	ChevronRightIcon,
	DownloadIcon,
	XIcon,
} from "@primer/octicons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useRef,
	useState,
} from "react";
import type { UpdateInfo } from "../shared/update";
import { ApiError, fetchJson } from "./api";
import { useUnsaved } from "./files/useSetStates";
import { SpinnerIcon } from "./Spinner";
import { ToastSlot } from "./Toasts";
import { Tooltip } from "./Tooltip";
import { Command, IconButton } from "./UpdateCommand";
import { WhatsNewModal } from "./WhatsNew";

export { Command };

/** How often the page asks whether an update is on offer, when none is. */
export const UPDATE_POLL_MS = 10 * 60_000;
/**
 * How often, while one is on offer: often enough to see another tab's (or
 * device's) Update while crb still answers (the server waits
 * RESTART_GRACE_MS before it stops).
 */
export const UPDATE_WATCH_MS = 5_000;
/** How often an updating page asks whether crb is back. */
export const BACK_POLL_MS = 1_000;
/** How long crb may take to install and come back before the page calls it failed. */
export const BACK_LIMIT_MS = 5 * 60_000;

const DISMISSED = "crb:update-dismissed";

export const UPDATE_KEY = ["update"] as const;

export const fetchUpdate = () =>
	fetchJson<UpdateInfo>("/api/update", { cache: "no-store" });

function readDismissed(): string | null {
	try {
		return globalThis.localStorage?.getItem(DISMISSED) ?? null;
	} catch {
		return null;
	}
}

function writeDismissed(version: string): void {
	try {
		globalThis.localStorage?.setItem(DISMISSED, version);
	} catch {
		// Dismissed for this page only.
	}
}

type Phase =
	| { kind: "idle" }
	| { kind: "updating"; version: string; since: number }
	/** crb is back on `version`, but this page has unsaved work: Reload asks. */
	| { kind: "back"; version: string }
	| { kind: "failed"; version: string; tail: string; command: string };

const CARD =
	"pointer-events-auto flex w-full flex-col rounded-lg border border-edge bg-overlay py-1 pr-1 pl-3 text-sm text-ink shadow-float";
const TEXT_BUTTON =
	"flex h-10 shrink-0 items-center rounded-md px-3 text-sm font-semibold text-ink hover:bg-pressed focus-visible:outline-2 focus-visible:outline-accent";
/** What a page shares with the update toast: its phase, and Update itself. */
export interface UpdateFlow {
	phase: Phase;
	/** The toast's Update: asks about unsaved work, installs, restarts, reloads. */
	update: (version: string) => Promise<void>;
	/** Opens What's new (the modal with the notes, and Update below). */
	whatsNew: () => void;
}

const FlowContext = createContext<UpdateFlow | null>(null);

/** The update flow of the page's UpdateToast (null outside one). */
export const useUpdateFlow = (): UpdateFlow | null => useContext(FlowContext);

/**
 * "Update available" (CAR-108): on every page, when npm has a newer crb on
 * its channel. Update installs it and restarts crb (asking first when the
 * page has unsaved work, as leaving does); the page shows it updating and
 * reloads once crb answers with the new version. When crb can't update
 * itself, the command to run instead. Dismissed per version. `children`
 * (the pages) share its Update (useUpdateFlow: Global settings' button).
 */
export function UpdateToast(props: { children?: ReactNode }) {
	const [phase, setPhase] = useState<Phase>({ kind: "idle" });
	const [whatsNewOpen, setWhatsNewOpen] = useState(false);
	const update = useRef<UpdateFlow["update"]>(async () => {});
	// One stable function for the pages: the latest Update behind it.
	const [flowUpdate] = useState(
		() => (version: string) => update.current(version),
	);
	const [whatsNew] = useState(() => () => setWhatsNewOpen(true));
	// Updating (or back, waiting for a reload): no notes to read, and an
	// ask made then never opens later by itself.
	const busy = phase.kind === "updating" || phase.kind === "back";
	useEffect(() => {
		if (busy) setWhatsNewOpen(false);
	}, [busy]);
	const info = useQuery({
		queryKey: UPDATE_KEY,
		queryFn: fetchUpdate,
		enabled: false,
	});
	return (
		<FlowContext.Provider value={{ phase, update: flowUpdate, whatsNew }}>
			{props.children}
			<Toast
				phase={phase}
				setPhase={setPhase}
				updateRef={update}
				whatsNew={whatsNew}
			/>
			<WhatsNewModal
				open={whatsNewOpen && !busy}
				onClose={() => setWhatsNewOpen(false)}
				info={info.data}
				onUpdate={(version) => void flowUpdate(version)}
			/>
		</FlowContext.Provider>
	);
}

function Toast(props: {
	phase: Phase;
	setPhase: (phase: Phase) => void;
	updateRef: { current: UpdateFlow["update"] };
	whatsNew: () => void;
}) {
	const { phase, setPhase } = props;
	const client = useQueryClient();
	const [dismissed, setDismissed] = useState<string | null>(readDismissed);
	const [failureDismissed, setFailureDismissed] = useState<string | null>(null);
	const unsaved = useUnsaved();
	const unsavedNow = useRef(unsaved);
	unsavedNow.current = unsaved;
	// crb runs `version` now: this page's code is the old one. Reloads at
	// once with nothing unsaved; else offers Reload, and leaving asks as
	// always (an ask the reviewer answered at Update covered only what was
	// unsaved then, and another tab's Update asked nothing here).
	const back = useCallback(
		(version: string) => {
			if (unsavedNow.current) setPhase({ kind: "back", version });
			else window.location.reload();
		},
		[setPhase],
	);
	const info = useQuery({
		queryKey: UPDATE_KEY,
		queryFn: fetchUpdate,
		retry: false,
		refetchOnWindowFocus: false,
		refetchInterval: (q) =>
			phase.kind === "updating"
				? false
				: q.state.data?.available
					? UPDATE_WATCH_MS
					: UPDATE_POLL_MS,
	});
	const data = info.data;

	// Another tab (or device) started it, or a failure crb reports.
	useEffect(() => {
		if (!data || phase.kind !== "idle") return;
		if (data.state !== "idle" && data.available) {
			setPhase({
				kind: "updating",
				version: data.available,
				since: Date.now(),
			});
		}
	}, [data, phase.kind, setPhase]);

	// crb now runs the version that was on offer (another tab's update this
	// page didn't see start): this page's code is the old one, reload.
	const offered = useRef<string | null>(null);
	useEffect(() => {
		if (!data) return;
		if (offered.current !== null && data.current === offered.current) {
			offered.current = null;
			back(data.current);
			return;
		}
		if (data.available) offered.current = data.available;
	}, [data, back]);

	// Updating: wait for crb to answer with the new version, then reload.
	const target = phase.kind === "updating" ? phase.version : null;
	const since = phase.kind === "updating" ? phase.since : 0;
	const latest = useRef(data);
	latest.current = data;
	useEffect(() => {
		if (target === null) return;
		let stopped = false;
		const tick = async () => {
			if (stopped) return;
			try {
				const v = await fetchJson<{ version: string; boot?: string }>(
					"/api/version",
					{ cache: "no-store" },
				);
				if (stopped) return;
				if (v.version === target) {
					back(target);
					return;
				}
				// The crb that announced its restart, in its grace: it stops
				// any moment, cutting off whatever is in flight (CAR-177), so
				// only /api/version (which waits for the new one anyway)
				// crosses that moment. Another crb (back after a failed
				// install), one still installing, or one too old to say which
				// it is: /api/update tells.
				const known = latest.current;
				const inGrace =
					known?.state === "restarting" &&
					known.boot !== undefined &&
					v.boot === known.boot;
				if (!inGrace) {
					const now = await fetchUpdate();
					if (stopped) return;
					client.setQueryData(UPDATE_KEY, now);
					if (now.state === "idle" && now.failed?.version === target) {
						setPhase({
							kind: "failed",
							version: target,
							tail: now.failed.tail,
							command: now.failed.command,
						});
						return;
					}
				}
			} catch {
				// Down while it installs: ask again.
			}
			if (Date.now() - since > BACK_LIMIT_MS) {
				setPhase({
					kind: "failed",
					version: target,
					tail: `crb did not come back with ${target} within ${BACK_LIMIT_MS / 60_000} minutes`,
					command: latest.current?.command ?? "",
				});
				return;
			}
			timer = window.setTimeout(tick, BACK_POLL_MS);
		};
		let timer = window.setTimeout(tick, BACK_POLL_MS);
		return () => {
			stopped = true;
			window.clearTimeout(timer);
		};
	}, [target, since, client, back, setPhase]);

	const dismiss = (version: string) => {
		writeDismissed(version);
		setDismissed(version);
		setPhase({ kind: "idle" });
	};
	// A failure's dismiss leaves the offer (and its Update) in place.
	const dismissFailure = (version: string) => {
		setFailureDismissed(version);
		setPhase({ kind: "idle" });
	};

	const update = async (version: string) => {
		if (
			unsaved &&
			!window.confirm(
				"This page has unsaved changes. Restart crb for the update and lose them?",
			)
		) {
			return;
		}
		setPhase({ kind: "updating", version, since: Date.now() });
		// A poll still out must not land after the POST's answer, over it.
		await client.cancelQueries({ queryKey: UPDATE_KEY });
		try {
			const answer = await fetchJson<UpdateInfo>("/api/update", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ version }),
			});
			client.setQueryData(UPDATE_KEY, answer);
		} catch (error) {
			// Unreachable: it may be stopping already; the wait tells.
			if (error instanceof ApiError && error.status !== 0) {
				setPhase({
					kind: "failed",
					version,
					tail: error.message,
					command: data?.command ?? "",
				});
			}
		}
	};
	props.updateRef.current = update;

	if (phase.kind === "updating") {
		return (
			<ToastSlot>
				<div
					role="status"
					data-testid="update-toast"
					data-state="updating"
					className={`${CARD} min-h-12 justify-center`}
				>
					<span className="flex items-center gap-2 py-2 pr-2">
						<SpinnerIcon className="shrink-0 text-accent" />
						<span className="min-w-0 truncate">
							Updating to <b className="font-semibold">v{phase.version}</b>…
						</span>
					</span>
				</div>
			</ToastSlot>
		);
	}

	if (phase.kind === "back") {
		return (
			<ToastSlot>
				<div
					role="status"
					data-testid="update-toast"
					data-state="back"
					className={`${CARD} min-h-12 justify-center`}
				>
					<div className="flex items-center gap-2">
						<CheckCircleIcon
							size={16}
							aria-hidden
							className="shrink-0 text-ok"
						/>
						<span className="min-w-0 flex-1 truncate">
							Updated to <b className="font-semibold">v{phase.version}</b>
						</span>
						<Tooltip content="Load the new version" describe={false}>
							{(trigger) => (
								<button
									type="button"
									{...trigger}
									onClick={() => window.location.reload()}
									className={TEXT_BUTTON}
								>
									Reload
								</button>
							)}
						</Tooltip>
					</div>
				</div>
			</ToastSlot>
		);
	}

	const failure =
		phase.kind === "failed"
			? phase
			: data?.failed && data.failed.version !== failureDismissed
				? data.failed
				: null;
	if (failure) {
		return (
			<ToastSlot>
				<div
					role="alert"
					data-testid="update-toast"
					data-state="failed"
					className={`${CARD} gap-1 pb-2`}
				>
					<div className="flex items-center gap-2">
						<AlertIcon size={16} aria-hidden className="shrink-0 text-bad" />
						<span className="min-w-0 flex-1 truncate font-semibold">
							Update to v{failure.version} failed
						</span>
						{data?.oneClick && data.available === failure.version && (
							<Tooltip content="Try again" describe={false}>
								{(trigger) => (
									<button
										type="button"
										{...trigger}
										onClick={() => void update(failure.version)}
										className={TEXT_BUTTON}
									>
										Retry
									</button>
								)}
							</Tooltip>
						)}
						<IconButton
							label="Dismiss"
							onClick={() => dismissFailure(failure.version)}
						>
							<XIcon size={16} aria-hidden />
						</IconButton>
					</div>
					<pre
						data-testid="update-output"
						className="max-h-32 overflow-auto rounded bg-code px-2 py-1 font-mono text-xs whitespace-pre-wrap break-all text-code-ink mr-2"
					>
						{failure.tail}
					</pre>
					{failure.command && <Command command={failure.command} />}
				</div>
			</ToastSlot>
		);
	}

	if (!data?.available || data.available === dismissed) return null;
	const version = data.available;
	return (
		<ToastSlot>
			<div
				role="status"
				data-testid="update-toast"
				data-state="available"
				className={`${CARD} min-h-12 justify-center`}
			>
				<div className="flex items-center gap-1">
					{/* The whole offer is the one button: it opens What's new. */}
					<Tooltip content={`What's new in v${version}`} describe={false}>
						{(trigger) => (
							<button
								type="button"
								{...trigger}
								data-testid="update-open"
								onClick={props.whatsNew}
								className="-ml-2 flex min-h-10 min-w-0 flex-1 items-center gap-2 rounded-md border border-line-strong bg-pressed px-3 text-left hover:border-accent hover:brightness-125 focus-visible:outline-2 focus-visible:outline-accent active:translate-y-px active:brightness-100 motion-reduce:active:translate-y-0"
							>
								<DownloadIcon
									size={16}
									aria-hidden
									className="shrink-0 text-accent"
								/>
								<span className="min-w-0 truncate">
									<b className="font-semibold">Update available</b>{" "}
									<span className="font-mono text-ink-soft">v{version}</span>
								</span>
								<ChevronRightIcon
									size={16}
									aria-hidden
									className="ml-auto shrink-0 text-muted"
								/>
							</button>
						)}
					</Tooltip>
					<IconButton label="Dismiss" onClick={() => dismiss(version)}>
						<XIcon size={16} aria-hidden />
					</IconButton>
				</div>
			</div>
		</ToastSlot>
	);
}
