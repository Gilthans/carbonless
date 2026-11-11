import {
	AlertIcon,
	CopyIcon,
	DownloadIcon,
	XIcon,
} from "@primer/octicons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { UpdateInfo } from "../shared/update";
import { ApiError, fetchJson } from "./api";
import { allowLeave, useUnsaved } from "./files/useSetStates";
import { SpinnerIcon } from "./Spinner";
import { ToastSlot } from "./Toasts";
import { Tooltip } from "./Tooltip";

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

const fetchUpdate = () =>
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
	| { kind: "failed"; version: string; tail: string; command: string };

const CARD =
	"pointer-events-auto flex w-full flex-col rounded-lg border border-edge bg-overlay py-1 pr-1 pl-3 text-sm text-ink shadow-float";
const ICON_BUTTON =
	"flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-faint hover:bg-pressed hover:text-ink focus-visible:outline-2 focus-visible:outline-accent";

function IconButton(props: {
	label: string;
	onClick: () => void;
	children: React.ReactNode;
}) {
	return (
		<Tooltip content={props.label} describe={false}>
			{(trigger) => (
				<button
					type="button"
					{...trigger}
					aria-label={props.label}
					onClick={props.onClick}
					className={ICON_BUTTON}
				>
					{props.children}
				</button>
			)}
		</Tooltip>
	);
}

/** A command to run by hand, with a copy button. */
function Command(props: { command: string }) {
	const [copied, setCopied] = useState(false);
	return (
		<div className="flex min-w-0 items-center gap-1">
			<code
				data-testid="update-command"
				className="min-w-0 flex-1 overflow-x-auto rounded bg-code px-2 py-1 font-mono text-xs whitespace-nowrap text-code-ink select-all"
			>
				{props.command}
			</code>
			<IconButton
				label={copied ? "Copied" : "Copy command"}
				onClick={() => {
					void navigator.clipboard
						?.writeText(props.command)
						.then(() => setCopied(true))
						.catch(() => {});
				}}
			>
				<CopyIcon size={16} aria-hidden />
			</IconButton>
		</div>
	);
}

/**
 * "Update available" (CAR-108): on every page, when npm has a newer crb on
 * its channel. Update installs it and restarts crb (asking first when the
 * page has unsaved work, as leaving does); the page shows it updating and
 * reloads once crb answers with the new version. When crb can't update
 * itself, the command to run instead. Dismissed per version.
 */
export function UpdateToast() {
	const client = useQueryClient();
	const [phase, setPhase] = useState<Phase>({ kind: "idle" });
	const [dismissed, setDismissed] = useState<string | null>(readDismissed);
	const unsaved = useUnsaved();
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
	}, [data, phase.kind]);

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
				const v = await fetchJson<{ version: string }>("/api/version", {
					cache: "no-store",
				});
				if (stopped) return;
				if (v.version === target) {
					allowLeave();
					window.location.reload();
					return;
				}
				// The old crb answers: still stopping, or back after a failure.
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
	}, [target, since, client]);

	const dismiss = (version: string) => {
		writeDismissed(version);
		setDismissed(version);
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
		if (unsaved) allowLeave();
		setPhase({ kind: "updating", version, since: Date.now() });
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

	const failure =
		phase.kind === "failed"
			? phase
			: data?.failed && data.failed.version !== dismissed
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
						<IconButton
							label="Dismiss"
							onClick={() => dismiss(failure.version)}
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
				<div className="flex items-center gap-2">
					<Tooltip content="Update available" describe={false}>
						{(trigger) => (
							<span {...trigger} className="flex shrink-0 text-accent">
								<DownloadIcon size={16} aria-hidden />
							</span>
						)}
					</Tooltip>
					{/* A phone has room for the icon and the version only. */}
					<b className="min-w-0 truncate font-semibold max-sm:sr-only">
						Update available
					</b>
					{data.releaseUrl && (
						<Tooltip content="What's new" describe={false}>
							{(trigger) => (
								<a
									{...trigger}
									href={data.releaseUrl ?? undefined}
									target="_blank"
									rel="noreferrer"
									className="flex h-10 shrink-0 items-center rounded-md px-1 font-mono text-link underline hover:bg-pressed focus-visible:outline-2 focus-visible:outline-accent"
								>
									v{version}
								</a>
							)}
						</Tooltip>
					)}
					<span className="flex-1" />
					{data.oneClick && (
						<Tooltip
							content={`Install v${version} and restart crb`}
							describe={false}
						>
							{(trigger) => (
								<button
									type="button"
									{...trigger}
									onClick={() => void update(version)}
									className="flex h-10 shrink-0 items-center rounded-md px-3 text-sm font-semibold text-ink hover:bg-pressed focus-visible:outline-2 focus-visible:outline-accent"
								>
									Update
								</button>
							)}
						</Tooltip>
					)}
					<IconButton label="Dismiss" onClick={() => dismiss(version)}>
						<XIcon size={16} aria-hidden />
					</IconButton>
				</div>
				{!data.oneClick && data.command && (
					<div className="pb-1">
						<Command command={data.command} />
					</div>
				)}
			</div>
		</ToastSlot>
	);
}
