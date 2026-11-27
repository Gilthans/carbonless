import { AlertIcon, DownloadIcon } from "@primer/octicons-react";
import { useQuery } from "@tanstack/react-query";
import { useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { UpdateInfo } from "../shared/update";
import { SpinnerIcon } from "./Spinner";
import { bannerSlot } from "./sticky";
import { Tooltip } from "./Tooltip";
import { Command } from "./UpdateCommand";
import { fetchUpdate, UPDATE_KEY, useUpdateFlow } from "./UpdateToast";

/**
 * "Withdrawn" (CAR-212): the running crb is a version its maintainer
 * withdrew (npm deprecated it with `withdrawn: `), on every page: a red
 * bar pinned at the top that pushes the page down (App's slot, above the
 * header; elsewhere pinned in place), with the maintainer's reason as plain
 * text. With a fix on offer, Update opens What's new (the toast's flow,
 * which installs it); by hand, the command; without one, "Fix coming"
 * (the page keeps asking). Never dismissed. Nothing until crb's check
 * answered (no banner while unknown).
 */
export function WithdrawnBanner() {
	const info = useQuery({
		queryKey: UPDATE_KEY,
		queryFn: fetchUpdate,
		retry: false,
		refetchOnWindowFocus: false,
	});
	const slot = bannerSlot.use();
	const withdrawn = info.data?.withdrawn;
	if (!info.data || !withdrawn) return null;
	const bar = <Bar info={info.data} reason={withdrawn.reason} />;
	return slot ? createPortal(bar, slot) : <InPlace>{bar}</InPlace>;
}

/**
 * Pinned at the top outside App: its height on the root as `--top-bar`,
 * for what sticks under it (Home's column header).
 */
function InPlace(props: { children: React.ReactNode }) {
	const ref = useRef<HTMLDivElement>(null);
	useLayoutEffect(() => {
		const node = ref.current;
		if (!node) return;
		const root = document.documentElement;
		const measure = () =>
			root.style.setProperty("--top-bar", `${node.offsetHeight}px`);
		measure();
		const observer =
			typeof ResizeObserver === "undefined"
				? null
				: new ResizeObserver(measure);
		observer?.observe(node);
		return () => {
			observer?.disconnect();
			root.style.removeProperty("--top-bar");
		};
	}, []);
	return (
		<div ref={ref} className="sticky top-0 z-[35]">
			{props.children}
		</div>
	);
}

const UPDATE_BUTTON =
	"flex min-h-10 shrink-0 items-center gap-1.5 rounded-md border border-del-ink bg-del-ink px-3 text-sm font-semibold text-surface hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-70";

function Bar(props: { info: UpdateInfo; reason: string }) {
	const { info } = props;
	const flow = useUpdateFlow();
	const version = info.available;
	const busy =
		info.state !== "idle" ||
		flow?.phase.kind === "updating" ||
		flow?.phase.kind === "back";
	let action: React.ReactNode;
	if (version && info.oneClick && flow) {
		action = (
			<Tooltip content={`What's new in v${version}`} describe={false}>
				{(trigger) => (
					<button
						type="button"
						{...trigger}
						data-testid="withdrawn-update"
						disabled={busy}
						onClick={flow.whatsNew}
						className={UPDATE_BUTTON}
					>
						{busy ? (
							<SpinnerIcon className="shrink-0" />
						) : (
							<DownloadIcon size={16} aria-hidden className="shrink-0" />
						)}
						<span className="whitespace-nowrap">Update to {version}</span>
					</button>
				)}
			</Tooltip>
		);
	} else if (version && info.command) {
		action = (
			<div className="w-full min-w-0 sm:w-auto sm:max-w-md sm:flex-1">
				<Command command={info.command} />
			</div>
		);
	} else if (!version) {
		action = (
			<span
				data-testid="withdrawn-fix-coming"
				className="flex min-h-10 shrink-0 items-center gap-1.5 text-muted"
			>
				<SpinnerIcon className="shrink-0" />
				Fix coming
			</span>
		);
	}
	return (
		// A labelled region, not a live one: it isn't announced again on
		// every page the reviewer opens.
		<section
			aria-label="Withdrawn version"
			data-testid="withdrawn-banner"
			className="flex flex-wrap items-center gap-x-2.5 gap-y-1 border-b border-del-ink bg-del px-3 py-1 text-sm text-del-ink sm:px-6"
		>
			<Tooltip content="Withdrawn version" describe={false}>
				{(trigger) => (
					<span
						{...trigger}
						role="img"
						aria-label="Withdrawn version"
						className="-mx-2 flex h-10 w-10 shrink-0 items-center justify-center"
					>
						<AlertIcon size={16} aria-hidden />
					</span>
				)}
			</Tooltip>
			<span className="shrink-0 font-bold">Withdrawn</span>
			<span
				data-testid="withdrawn-reason"
				className="min-w-0 flex-[1_1_10rem] break-words text-ink"
			>
				{/* No reason given: the version alone, no dangling ": ". */}
				{[info.current, props.reason].filter((t) => t !== "").join(": ")}
			</span>
			{action}
		</section>
	);
}
