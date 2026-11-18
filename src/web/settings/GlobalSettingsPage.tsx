import {
	AlertIcon,
	CheckCircleIcon,
	ChevronDownIcon,
	CircleSlashIcon,
	DownloadIcon,
	GitCommitIcon,
	PackageIcon,
	SyncIcon,
} from "@primer/octicons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useEffect, useState } from "react";
import type { ReleaseNote } from "../../shared/releaseNotes";
import type { ChecksOff, UpdateInfo } from "../../shared/update";
import {
	compareUrl,
	type NotesSection,
	type OwnNotes,
	RELEASES_URL,
	splitNote,
} from "../../shared/whatsNew";
import { fetchJson } from "../api";
import { Logo } from "../brand/Brand";
import { RelativeTime } from "../RelativeTime";
import { SkeletonBar, Spinner, SpinnerIcon } from "../Spinner";
import { Tooltip } from "../Tooltip";
import { ByHandWhy } from "../UpdateByHand";
import {
	Command,
	fetchUpdate,
	UPDATE_KEY,
	useUpdateFlow,
} from "../UpdateToast";
import {
	Dropped,
	MoreToggle,
	NoteRow,
	Uncovered,
	VersionHead,
	VersionLink,
} from "../WhatsNew";

/** Why crb never checks, in a few words. */
export const OFF_REASON: Record<ChecksOff, string> = {
	"local-build": "local build",
	env: "CRB_NO_UPDATE_CHECK",
	config: "updates.check off",
	unavailable: "not on this server",
};

const BUTTON =
	"inline-flex h-10 shrink-0 items-center gap-2 rounded-md border border-line-strong px-3 text-sm font-semibold text-ink hover:bg-overlay focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-60";

/** One line of a section: an icon, then its content. */
function Row(props: {
	icon: ReactNode;
	label: string;
	testId?: string;
	children: ReactNode;
}) {
	return (
		<div
			data-testid={props.testId}
			className="flex min-h-10 min-w-0 flex-wrap items-center gap-x-2 gap-y-1"
		>
			<Tooltip content={props.label} describe={false}>
				{(trigger) => (
					<span
						{...trigger}
						role="img"
						aria-label={props.label}
						className="flex w-4 shrink-0 text-muted"
					>
						{props.icon}
					</span>
				)}
			</Tooltip>
			{props.children}
		</div>
	);
}

/** A section of the page: its heading, then its rows. */
function Section(props: {
	title: string;
	busy?: boolean;
	children: ReactNode;
}) {
	const id = `settings-${props.title.toLowerCase()}`;
	return (
		<section
			aria-labelledby={id}
			aria-busy={props.busy || undefined}
			data-testid={id}
			className="rounded-lg border border-line bg-surface px-4 py-3"
		>
			<h2
				id={id}
				className="mb-1 text-xs font-semibold tracking-[0.18em] text-label uppercase"
			>
				{props.title}
			</h2>
			<div className="space-y-1 text-sm">{props.children}</div>
		</section>
	);
}

/**
 * The result of the last check: a newer version (whatever happened since:
 * a failed check keeps what an earlier one found), a failure, or up to
 * date. While an update is under way, no failure: Check is off then.
 */
function CheckResult(props: {
	info: UpdateInfo;
	checking: boolean;
	updating: boolean;
	failed: string | null;
	retry: () => void;
}) {
	const { info, updating } = props;
	const flow = useUpdateFlow();
	if (props.checking) {
		return (
			<Row icon={<SpinnerIcon />} label="Checking" testId="update-result">
				<span className="text-muted">Checking…</span>
			</Row>
		);
	}
	const version = info.available;
	const failure = updating ? null : (props.failed ?? info.checkError);
	if (!version && !failure && !info.lastChecked) return null;
	return (
		<div
			data-testid="update-result"
			data-state={version ? "available" : failure ? "failed" : "current"}
		>
			{version && (
				<Row
					icon={<DownloadIcon className="text-accent" />}
					label="Update available"
				>
					<span className="font-mono font-semibold">v{version}</span>
					<span className="text-muted">available</span>
					{flow && (
						<Tooltip content={`What's new in v${version}`} describe={false}>
							{(trigger) => (
								<button
									type="button"
									{...trigger}
									onClick={flow.whatsNew}
									className={`${BUTTON} ml-auto`}
								>
									What's new
								</button>
							)}
						</Tooltip>
					)}
					{info.oneClick &&
						flow &&
						(updating ? (
							<Spinner label={`Updating to v${version}`}>Updating…</Spinner>
						) : (
							<Tooltip
								content={`Install v${version} and restart crb`}
								describe={false}
							>
								{(trigger) => (
									<button
										type="button"
										{...trigger}
										onClick={() => void flow.update(version)}
										className={BUTTON}
									>
										Update
									</button>
								)}
							</Tooltip>
						))}
				</Row>
			)}
			{version && !info.oneClick && info.command && (
				<div className="pl-6">
					<Command command={info.command} />
				</div>
			)}
			{failure && (
				<Row icon={<AlertIcon className="text-bad" />} label="Check failed">
					<span data-testid="check-failed" className="min-w-0 text-bad">
						Check failed: {failure}
					</span>
					<button type="button" onClick={props.retry} className={BUTTON}>
						Retry
					</button>
				</Row>
			)}
			{!version && !failure && (
				<Row icon={<CheckCircleIcon className="text-ok" />} label="Up to date">
					<span>Up to date</span>
				</Row>
			)}
		</div>
	);
}

/** The running build's own notes (its package's file, no network). */
const ownNotesQuery = {
	queryKey: ["release-notes"],
	queryFn: () => fetchJson<OwnNotes>("/api/release-notes"),
	retry: false,
	staleTime: Number.POSITIVE_INFINITY,
	refetchOnWindowFocus: false,
} as const;

/** How many of a version's notes show before its Show more. */
export const NOTES_FOLDED = 3;
/** How many earlier releases Show more opens, and Show more versions adds. */
export const OLDER_STEP = 5;

/** Notes that show more once unfolded: past NOTES_FOLDED, or a note past its first sentence. */
const foldable = (notes: ReleaseNote[]) =>
	notes.length > NOTES_FOLDED ||
	notes.some((n) => splitNote(n.text).rest !== "");

/**
 * An earlier release under the running version's notes: its version and
 * day, its first notes folded, its own Show more for all of them in full.
 */
function OlderVersion(props: { section: NotesSection }) {
	const { section } = props;
	const [open, setOpen] = useState(false);
	const notes = open ? section.notes : section.notes.slice(0, NOTES_FOLDED);
	return (
		<section
			data-testid="notes-version"
			data-version={section.version}
			className="border-t border-line pt-1"
		>
			<VersionHead section={section} linkVersion />
			{notes.length > 0 ? (
				<ul className="m-0 list-none p-0">
					{notes.map((n) => (
						<NoteRow key={`${n.id}:${n.text}`} note={n} summary={!open} />
					))}
				</ul>
			) : (
				<p className="flex min-h-10 items-center text-muted">
					No user-facing changes
				</p>
			)}
			{foldable(section.notes) && (
				<MoreToggle open={open} onToggle={() => setOpen((o) => !o)} />
			)}
		</section>
	);
}

/**
 * The running version's notes, under Version (from its own package, no
 * network): the first NOTES_FOLDED, first sentence each; Show more
 * expands in place to every note in full and the earlier releases. A
 * build without notes (a local build) shows nothing here.
 */
function RunningNotes() {
	const [open, setOpen] = useState(false);
	// How many earlier releases show once open: OLDER_STEP more per press.
	const [shown, setShown] = useState(OLDER_STEP);
	const own = useQuery(ownNotesQuery);
	const box = "pl-6";
	if (own.isPending) {
		return (
			<div
				data-testid="running-notes"
				aria-busy
				className={`${box} space-y-2 py-1`}
			>
				<Spinner label="Loading the release notes" className="sr-only" />
				<SkeletonBar className="w-64 max-w-full" />
				<SkeletonBar className="w-52 max-w-full" />
			</div>
		);
	}
	if (own.isError) {
		return (
			<p
				data-testid="running-notes"
				role="alert"
				className={`${box} flex min-h-10 items-center gap-2 text-warn`}
			>
				<AlertIcon size={16} aria-hidden className="shrink-0" />
				Notes didn't load: {own.error.message}
			</p>
		);
	}
	const data = own.data;
	if (!data.file || !data.running) return null;
	const running = data.running;
	const notes = open ? running.notes : running.notes.slice(0, NOTES_FOLDED);
	const more = foldable(running.notes) || data.earlier.length > 0;
	return (
		<div data-testid="running-notes" className={`${box} min-w-0`}>
			<Dropped count={data.dropped} />
			{notes.length > 0 ? (
				<ul className="m-0 list-none p-0">
					{notes.map((n) => (
						<NoteRow key={`${n.id}:${n.text}`} note={n} summary={!open} />
					))}
				</ul>
			) : (
				running.uncovered.length === 0 && (
					<p className="flex min-h-10 items-center text-muted">
						No user-facing changes
					</p>
				)
			)}
			{/* Folded too: changes without notes are never left out. */}
			<Uncovered
				count={running.uncovered.length}
				href={
					data.earlier[0]
						? compareUrl(data.earlier[0].version, data.current)
						: RELEASES_URL
				}
			/>
			{open && (
				<>
					{data.earlier.slice(0, shown).map((s) => (
						<OlderVersion key={s.version} section={s} />
					))}
				</>
			)}
			{/* One wrapping row: the two never overlap, at any width. */}
			{(more || (open && data.earlier.length > shown)) && (
				<div className="flex flex-wrap items-center gap-x-4 gap-y-1">
					{open && data.earlier.length > shown && (
						<button
							type="button"
							data-testid="more-versions"
							onClick={() => setShown((n) => n + OLDER_STEP)}
							className="inline-flex min-h-10 items-center gap-1 rounded-md text-sm font-semibold text-link hover:underline focus-visible:outline-2 focus-visible:outline-accent"
						>
							<ChevronDownIcon size={16} aria-hidden />
							Show more versions
						</button>
					)}
					{more && (
						<MoreToggle
							testId="running-notes-toggle"
							open={open}
							onToggle={() => {
								setOpen((o) => !o);
								setShown(OLDER_STEP);
							}}
						/>
					)}
				</div>
			)}
		</div>
	);
}

/** The running crb: its version (linking its release), its channel, and updates. */
function VersionSection() {
	const client = useQueryClient();
	const flow = useUpdateFlow();
	// When the last manual check failed: its failure shows until fresher
	// info arrives (the toast's poll, another tab's check).
	const [failedAt, setFailedAt] = useState(0);
	const info = useQuery({
		queryKey: UPDATE_KEY,
		queryFn: fetchUpdate,
		retry: false,
		refetchOnWindowFocus: false,
	});
	const own = useQuery(ownNotesQuery);
	const check = useMutation({
		mutationFn: () =>
			fetchJson<UpdateInfo>("/api/update/check", {
				method: "POST",
				cache: "no-store",
			}),
		onSuccess: (answer) => client.setQueryData(UPDATE_KEY, answer),
		onError: () => setFailedAt(Date.now()),
	});
	const data = info.data;
	if (!data) {
		return (
			<Section title="Version" busy={info.isPending}>
				{info.isError ? (
					<p role="alert" className="py-2 text-bad">
						{info.error.message}
					</p>
				) : (
					<>
						<Spinner label="Loading the version" className="min-h-10" />
						<SkeletonBar className="w-40" />
						<SkeletonBar className="w-56" />
					</>
				)}
			</Section>
		);
	}
	const updating = flow?.phase.kind === "updating" || data.state !== "idle";
	const failed =
		check.isError && info.dataUpdatedAt <= failedAt
			? check.error.message
			: null;
	// A build npm served (or one with its notes: CI's) has a release on
	// GitHub; a local build has none: its version is plain text.
	const released =
		data.checksOff === null ||
		data.checksOff === "env" ||
		data.checksOff === "config" ||
		own.data?.file === true;
	const how = data.install ? `${data.install} global` : null;
	return (
		<Section title="Version" busy={check.isPending}>
			<Row icon={<GitCommitIcon />} label="Running" testId="version-current">
				{released ? (
					<VersionLink
						version={data.current}
						testId="version-link"
						className="font-semibold"
					/>
				) : (
					<span className="font-mono font-semibold">{data.current}</span>
				)}
			</Row>
			<RunningNotes />
			<Row icon={<PackageIcon />} label="Install" testId="version-install">
				<span>
					channel <b className="font-mono font-semibold">{data.channel}</b>
				</span>
				{data.checksOff ? (
					<span
						data-testid="updates-off"
						className="inline-flex items-center gap-1 text-muted"
					>
						<span aria-hidden>·</span>
						<CircleSlashIcon size={12} aria-hidden className="shrink-0" />
						updates off: {OFF_REASON[data.checksOff]}
					</span>
				) : (
					<>
						{how && <span className="text-muted">· {how}</span>}
						{/* Its own line, under the text (past the icon's w-4 and gap-2). */}
						{data.byHand && (
							<ByHandWhy
								info={data}
								prefix="No auto-update"
								className="basis-full pl-6 text-muted"
							/>
						)}
					</>
				)}
			</Row>
			{!data.checksOff && (
				<>
					<Row icon={<SyncIcon />} label="Last check" testId="version-checked">
						<span className="text-muted">
							{data.lastChecked ? (
								<>
									checked <RelativeTime iso={data.lastChecked} />
								</>
							) : (
								"never checked"
							)}
						</span>
						<button
							type="button"
							onClick={() => check.mutate()}
							disabled={check.isPending || updating}
							aria-busy={check.isPending || undefined}
							className={`${BUTTON} ml-auto`}
						>
							<SyncIcon
								aria-hidden
								className={
									check.isPending
										? "animate-spin motion-reduce:animate-none"
										: ""
								}
							/>
							Check for updates
						</button>
					</Row>
					<CheckResult
						info={data}
						checking={check.isPending}
						updating={updating}
						failed={failed}
						retry={() => check.mutate()}
					/>
				</>
			)}
		</Section>
	);
}

/** Global settings (`/settings`): crb's own, not a review's. More sections go here. */
export function GlobalSettingsPage() {
	useEffect(() => {
		document.title = "Global settings · carbonless";
	}, []);
	return (
		<div className="min-h-screen bg-canvas font-sans text-ink">
			<header className="border-b border-line bg-surface header-glow">
				<div className="mx-auto flex max-w-3xl items-center gap-2 px-4 py-3 sm:gap-3 sm:px-6">
					<Tooltip content="Home" describe={false}>
						{(trigger) => (
							<Link
								{...trigger}
								to="/"
								aria-label="Home"
								className="shrink-0 rounded-full focus-visible:outline-2 focus-visible:outline-accent"
							>
								<Logo className="h-10 w-10" />
							</Link>
						)}
					</Tooltip>
					<h1 className="font-display text-xl font-bold tracking-tight sm:text-2xl">
						Global settings
					</h1>
				</div>
			</header>
			<main className="mx-auto max-w-3xl space-y-4 px-4 py-6 sm:px-6">
				<VersionSection />
			</main>
		</div>
	);
}
