import {
	AlertIcon,
	CheckCircleIcon,
	CircleSlashIcon,
	DownloadIcon,
	GitCommitIcon,
	LinkExternalIcon,
	PackageIcon,
	SyncIcon,
} from "@primer/octicons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useEffect } from "react";
import {
	type ChecksOff,
	commitUrl,
	type UpdateInfo,
} from "../../shared/update";
import { fetchJson } from "../api";
import { Logo } from "../brand/Brand";
import { RelativeTime } from "../RelativeTime";
import { SkeletonBar, Spinner, SpinnerIcon } from "../Spinner";
import { Tooltip } from "../Tooltip";
import {
	Command,
	fetchUpdate,
	UPDATE_KEY,
	useUpdateFlow,
} from "../UpdateToast";

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

/** The result of the last check: up to date, a newer version, or a failure. */
function CheckResult(props: {
	info: UpdateInfo;
	checking: boolean;
	failed: string | null;
	retry: () => void;
}) {
	const { info } = props;
	const flow = useUpdateFlow();
	if (props.checking) {
		return (
			<Row icon={<SpinnerIcon />} label="Checking" testId="update-result">
				<span className="text-muted">Checking…</span>
			</Row>
		);
	}
	const failure = props.failed ?? info.checkError;
	if (failure) {
		return (
			<Row
				icon={<AlertIcon className="text-bad" />}
				label="Check failed"
				testId="update-result"
			>
				<span data-state="failed" className="min-w-0 text-bad">
					Check failed: {failure}
				</span>
				<button type="button" onClick={props.retry} className={BUTTON}>
					Retry
				</button>
			</Row>
		);
	}
	const version = info.available;
	if (version) {
		const updating = flow?.phase.kind === "updating" || info.state !== "idle";
		return (
			<div data-testid="update-result" data-state="available">
				<Row
					icon={<DownloadIcon className="text-accent" />}
					label="Update available"
				>
					{info.releaseUrl ? (
						<Tooltip content="What's new" describe={false}>
							{(trigger) => (
								<a
									{...trigger}
									href={info.releaseUrl ?? undefined}
									target="_blank"
									rel="noreferrer"
									className="inline-flex min-h-10 items-center gap-1 font-mono text-link underline"
								>
									v{version}
									<LinkExternalIcon size={12} aria-hidden />
								</a>
							)}
						</Tooltip>
					) : (
						<span className="font-mono">v{version}</span>
					)}
					<span className="text-muted">available</span>
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
				{!info.oneClick && info.command && (
					<div className="pl-6">
						<Command command={info.command} />
					</div>
				)}
			</div>
		);
	}
	if (info.lastChecked) {
		return (
			<Row
				icon={<CheckCircleIcon className="text-ok" />}
				label="Up to date"
				testId="update-result"
			>
				<span data-state="current">Up to date</span>
			</Row>
		);
	}
	return null;
}

/** The running crb: its version and commit, its channel, and updates. */
function VersionSection() {
	const client = useQueryClient();
	const info = useQuery({
		queryKey: UPDATE_KEY,
		queryFn: fetchUpdate,
		retry: false,
		refetchOnWindowFocus: false,
	});
	const check = useMutation({
		mutationFn: () =>
			fetchJson<UpdateInfo>("/api/update/check", {
				method: "POST",
				cache: "no-store",
			}),
		onSuccess: (answer) => client.setQueryData(UPDATE_KEY, answer),
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
	const commit = commitUrl(data.commit);
	const short = data.commit.replace(/-dirty$/, "").slice(0, 7);
	const dirty = data.commit.endsWith("-dirty") ? "-dirty" : "";
	const how = [
		data.install ? `${data.install} global` : null,
		data.byHand ? "update by hand" : null,
	].filter((t) => t !== null);
	return (
		<Section title="Version" busy={check.isPending}>
			<Row icon={<GitCommitIcon />} label="Running" testId="version-current">
				<span className="font-mono font-semibold">{data.current}</span>
				<span aria-hidden className="text-faint">
					·
				</span>
				{commit ? (
					<Tooltip content="Commit on GitHub" describe={false}>
						{(trigger) => (
							<a
								{...trigger}
								href={commit}
								target="_blank"
								rel="noreferrer"
								className="inline-flex min-h-10 items-center gap-1 font-mono text-link underline"
							>
								{short}
								<LinkExternalIcon size={12} aria-hidden />
							</a>
						)}
					</Tooltip>
				) : (
					<span className="font-mono text-muted">
						{short}
						{dirty}
					</span>
				)}
			</Row>
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
					how.length > 0 && (
						<span className="text-muted">· {how.join(" · ")}</span>
					)
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
							disabled={check.isPending}
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
						failed={check.isError ? check.error.message : null}
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
