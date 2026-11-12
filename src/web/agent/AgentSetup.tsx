import {
	CheckIcon,
	InfoIcon,
	PlugIcon,
	SparkleFillIcon,
	XIcon,
} from "@primer/octicons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	type KeyboardEvent,
	type ReactNode,
	useCallback,
	useEffect,
	useId,
	useRef,
	useState,
} from "react";
import type { AgentCheck, AgentConfig } from "../../shared/agent";
import {
	AGENT_HARNESSES,
	type AgentHarness,
} from "../../shared/agentHarnesses";
import { boundReviewId } from "../api";
import { type Copied, CopyMark, copyInto, copyWord } from "../CopyMark";
import { Spinner } from "../Spinner";
import { Tooltip, TooltipLayer } from "../Tooltip";
import { NOT_PHONE, useMedia } from "../useMedia";
import {
	agentConfigQuery,
	agentStatusQuery,
	checkAgentConfig,
	joinLine,
	joinSetupQuery,
	mcpAddLine,
	putAgentConfig,
} from "./api";
import { formatArgs, parseArgs } from "./args";
import {
	closeAgentSetup,
	type SetupTab,
	setAgentSetupTab,
	useAgentSetupOpen,
	useAgentSetupTab,
} from "./setupStore";

type HarnessId = AgentHarness["id"];

const harness = (id: HarnessId | null) =>
	AGENT_HARNESSES.find((h) => h.id === id);

/**
 * The config the fields say. The env and leash config.json has for this
 * command go along unchanged (a hand-written env must survive a Save);
 * another command starts with none. Nothing is added to env by itself.
 */
/** A command's last path part: `/srv/x/node_modules/.bin/claude-agent-acp` → `claude-agent-acp`. */
export const basename = (command: string): string =>
	command.trim().split(/[\\/]/).pop() ?? "";

/**
 * The harness a stored config is: the one whose command is the config's
 * command or its basename (an absolute path, as under a service), with the
 * same arguments.
 */
export function presetOf(agent: AgentConfig): AgentHarness | undefined {
	return AGENT_HARNESSES.find(
		(h) =>
			h.id !== "other" &&
			(h.command === agent.command || h.command === basename(agent.command)) &&
			JSON.stringify(h.args) === JSON.stringify(agent.args),
	);
}

const configOf = (
	command: string,
	args: string,
	stored: AgentConfig | null | undefined,
): AgentConfig => {
	const same = stored && stored.command === command.trim() ? stored : null;
	return {
		command: command.trim(),
		args: parseArgs(args),
		env: same?.env ?? {},
		leash: same?.leash ?? "open",
	};
};

const keyOf = (c: AgentConfig) =>
	JSON.stringify([c.command, c.args, c.env, c.leash]);

/** The setup's tabs: id, icon, name, and a phone's short label ("" = icon only). */
const TABS = [
	["launch", SparkleFillIcon, "Launch an agent", ""],
	["join", PlugIcon, "Join from a session", "Join"],
] as const;

const STEP = "text-xs font-semibold tracking-[0.1em] text-faint uppercase";
const BUTTON =
	"flex h-10 shrink-0 items-center justify-center gap-1.5 rounded-md border border-line-strong px-3 text-sm font-medium text-ink-soft hover:bg-overlay hover:text-ink focus-visible:outline-2 focus-visible:outline-accent disabled:text-faint disabled:hover:bg-transparent";
const FIELD =
	"block h-10 w-full min-w-0 rounded-md border border-line-strong bg-code px-3 font-mono text-xs text-code-ink read-only:text-ink-soft focus-visible:border-accent focus-visible:outline-2 focus-visible:outline-accent";

function Field(props: { label: string; children: ReactNode }) {
	return (
		<div className="grid min-w-0 gap-1">
			<span className="text-sm text-muted">{props.label}</span>
			{props.children}
		</div>
	);
}

/** What a session that's already running does to pick up a line just added. */
export const RELOAD_HINT = "Session already running? /reload-plugins";

/**
 * One line to copy: read-only, selected on focus, with an icon Copy button
 * and, with `hint`, an info icon whose tooltip (and name) is the hint.
 */
function CopyRow(props: {
	label: string;
	value: string;
	testId: string;
	hint?: string;
}) {
	const [copied, setCopied] = useState<Copied>(null);
	const field = useRef<HTMLInputElement>(null);
	return (
		<div className="flex min-w-0 gap-1.5">
			<input
				ref={field}
				readOnly
				aria-label={props.label}
				data-testid={props.testId}
				value={props.value}
				onFocus={(e) => e.currentTarget.select()}
				className={FIELD}
			/>
			<Tooltip content={copyWord(copied)} describe={false}>
				{(trigger) => (
					<button
						type="button"
						{...trigger}
						aria-label={`Copy ${props.label.toLowerCase()}`}
						onClick={() => {
							void copyInto(props.value, field.current, setCopied);
						}}
						className={`${BUTTON} w-10 px-0`}
					>
						<CopyMark copied={copied} />
					</button>
				)}
			</Tooltip>
			{props.hint && (
				<Tooltip content={props.hint} describe={false}>
					{(trigger) => (
						<span
							{...trigger}
							role="img"
							aria-label={props.hint}
							data-testid={`${props.testId}-hint`}
							// Focusable so keyboard and touch users get the tip.
							// biome-ignore lint/a11y/noNoninteractiveTabindex: the tooltip opens on focus.
							tabIndex={0}
							className="flex size-10 shrink-0 items-center justify-center rounded-md text-muted focus-visible:outline-2 focus-visible:outline-accent"
						>
							<InfoIcon size={16} aria-hidden />
						</span>
					)}
				</Tooltip>
			)}
		</div>
	);
}

/**
 * "Join from a session": the one-time line that adds this crb's /mcp to
 * Claude Code (with the access key), and the sentence that has a session
 * join this review. The key is read from the server (the page's cookie is
 * HttpOnly); a spinner holds the line's place meanwhile.
 */
function JoinTab(props: { open: boolean; id: string; labelledBy: string }) {
	const id = boundReviewId();
	const setup = useQuery({ ...joinSetupQuery, enabled: props.open });
	const origin = window.location.origin;
	return (
		<div
			role="tabpanel"
			id={props.id}
			aria-labelledby={props.labelledBy}
			data-testid="agent-join-tab"
			className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3"
		>
			<Field label="Once per machine">
				{setup.data ? (
					<CopyRow
						label="Setup line"
						testId="join-setup-line"
						value={mcpAddLine(origin, setup.data.key)}
						hint={RELOAD_HINT}
					/>
				) : setup.isError ? (
					<p role="alert" className="text-sm text-bad">
						{setup.error.message}
					</p>
				) : (
					<div aria-busy="true" className="flex h-10 items-center">
						<Spinner label="Loading the setup line" size={14} />
					</div>
				)}
			</Field>
			{id && (
				<Field label="Tell your session">
					<CopyRow
						label="Join line"
						testId="join-line"
						value={joinLine(origin, id)}
					/>
				</Field>
			)}
		</div>
	);
}

/**
 * Setting up the reviewer's agent, on one panel: pick a harness (it fills
 * the command and shows its install line, copyable; Other is typed), Check
 * it (its name and version, or why not with the adapter's stderr), see the
 * leash, then Save (once a Check of these fields succeeded) or Remove.
 * carbonless installs nothing. A centred dialog on a desktop, a bottom
 * sheet on a phone; Escape and Cancel close it, focus going back to what
 * opened it. The page's shortcuts don't fire under it (they skip `:modal`).
 */
export function AgentSetup(props: {
	open: boolean;
	onClose(): void;
	tab?: SetupTab;
	onTab?(tab: SetupTab): void;
}) {
	const { open, onClose } = props;
	const tab = props.tab ?? "launch";
	const client = useQueryClient();
	const wide = useMedia(NOT_PHONE);
	const stored = useQuery({ ...agentConfigQuery, enabled: open });
	const configured = Boolean(stored.data?.agent);
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
	const [pick, setPick] = useState<HarnessId | null>(null);
	const [command, setCommand] = useState("");
	const [args, setArgs] = useState("");
	const [checked, setChecked] = useState<{
		key: string;
		result: AgentCheck;
	} | null>(null);
	const [copied, setCopied] = useState<Copied>(null);
	const install = useRef<HTMLInputElement>(null);
	const choose = (id: HarnessId) => {
		const h = harness(id);
		setPick(id);
		if (h && id !== "other") {
			// The stored command when it is this harness's (an absolute path
			// stays one), else the harness's own.
			const mine =
				read?.agent && presetOf(read.agent)?.id === id
					? read.agent.command
					: h.command;
			setCommand(mine);
			setArgs(formatArgs(h.args));
		} else if (id === "other" && pick !== "other") {
			setCommand("");
			setArgs("");
		}
		setCopied(null);
	};
	// Each opening starts from what config.json says, once it is read: the
	// harness whose command and arguments it has (else Other with them),
	// Claude Code when none is set up.
	const shownFor = useRef<unknown>(null);
	const read =
		open && stored.isSuccess && !stored.isFetching ? stored.data : null;
	useEffect(() => {
		if (!open) {
			shownFor.current = null;
			return;
		}
		if (!read || shownFor.current === read) return;
		shownFor.current = read;
		const agent = read.agent;
		const preset = agent ? presetOf(agent) : harness("claude-code");
		setPick(preset?.id ?? "other");
		// A stored command is kept as written (an absolute path included).
		setCommand(agent?.command ?? preset?.command ?? "");
		setArgs(formatArgs(preset?.args ?? agent?.args ?? []));
		setChecked(null);
		setCopied(null);
	}, [open, read]);
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
	const config = configOf(command, args, read?.agent);
	const current = checked?.key === keyOf(config) ? checked.result : null;
	const check = useMutation({
		mutationFn: (c: AgentConfig) =>
			checkAgentConfig(c).then((result) => ({ key: keyOf(c), result })),
		onSuccess: (r) => setChecked(r),
	});
	const done = () => {
		void client.invalidateQueries({ queryKey: agentStatusQuery.queryKey });
		void client.invalidateQueries({ queryKey: agentConfigQuery.queryKey });
		onClose();
	};
	const save = useMutation({
		mutationFn: (c: AgentConfig | null) => putAgentConfig(c),
		onSuccess: done,
	});
	// Each opening starts clean: no Check result, error or Save from before.
	const resetCheck = check.reset;
	const resetSave = save.reset;
	useEffect(() => {
		if (!open) return;
		resetCheck();
		resetSave();
	}, [open, resetCheck, resetSave]);
	const chosen = harness(pick);
	const editable = pick === "other";
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
	const busy = check.isPending || save.isPending;
	return (
		<dialog
			ref={setDialog}
			aria-labelledby={titleId}
			data-testid="agent-setup"
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
				<div className="flex shrink-0 items-center gap-2 border-b border-line py-1 pr-1 pl-4">
					<SparkleFillIcon size={16} aria-hidden className="text-agent-ink" />
					<h2 id={titleId} className="font-semibold">
						Your agent
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
								className="ml-auto flex h-10 w-10 items-center justify-center rounded-md text-ink-soft hover:bg-overlay hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
							>
								<XIcon aria-hidden />
							</button>
						)}
					</Tooltip>
				</div>
				<div
					role="tablist"
					aria-label="How your agent joins"
					className="flex shrink-0 gap-1 border-b border-line px-2"
				>
					{TABS.map(([t, Icon, label, short]) => (
						<Tooltip key={t} content={label} describe={false}>
							{(trigger) => (
								<button
									type="button"
									{...trigger}
									ref={(el) => {
										tabRefs.current[t] = el;
										trigger.ref(el);
									}}
									role="tab"
									id={`${titleId}-tab-${t}`}
									aria-controls={`${titleId}-panel-${t}`}
									aria-selected={tab === t}
									aria-label={label}
									tabIndex={tab === t ? 0 : -1}
									data-testid={`agent-setup-tab-${t}`}
									onClick={() => props.onTab?.(t)}
									onKeyDown={(e) => {
										trigger.onKeyDown(e);
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
									className={`-mb-px flex min-h-10 min-w-10 items-center justify-center gap-1.5 border-b-2 px-2.5 text-sm whitespace-nowrap focus-visible:outline-2 focus-visible:outline-accent ${
										tab === t
											? "border-agent-ink text-agent-ink"
											: "border-transparent text-muted hover:text-ink"
									}`}
								>
									<Icon size={16} aria-hidden />
									{short && (
										<span aria-hidden className="sm:hidden">
											{short}
										</span>
									)}
									<span aria-hidden className="hidden sm:inline">
										{label}
									</span>
								</button>
							)}
						</Tooltip>
					))}
				</div>
				{tab === "join" && (
					<JoinTab
						open={open}
						id={`${titleId}-panel-join`}
						labelledBy={`${titleId}-tab-join`}
					/>
				)}
				{tab === "launch" && (
					<div
						role="tabpanel"
						id={`${titleId}-panel-launch`}
						aria-labelledby={`${titleId}-tab-launch`}
						className="flex min-h-0 flex-1 flex-col"
					>
						{tab === "launch" && open && !read && (
							<div aria-busy="true" className="px-4 py-6">
								{stored.isError ? (
									<p role="alert" className="text-sm text-bad">
										{stored.error.message}
									</p>
								) : (
									<Spinner label="Loading your agent" />
								)}
							</div>
						)}
						{tab === "launch" && open && read && (
							<div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
								{read.problems.length > 0 && (
									<ul
										data-testid="agent-config-problems"
										className="space-y-1 text-sm text-bad"
									>
										{read.problems.map((p) => (
											<li key={p}>{p}</li>
										))}
									</ul>
								)}
								<fieldset className="min-w-0 space-y-2">
									<legend className={STEP}>1 · harness</legend>
									<div
										role="radiogroup"
										aria-label="Harness"
										className="grid grid-cols-2 gap-1.5 sm:grid-cols-3"
									>
										{AGENT_HARNESSES.map((h) => (
											<label
												key={h.id}
												className={`flex min-h-10 min-w-0 cursor-pointer items-center gap-2 rounded-md border bg-raised px-2.5 text-sm has-focus-visible:outline-2 has-focus-visible:outline-accent ${
													pick === h.id
														? "border-agent-edge text-ink shadow-[inset_0_0_0_1px_var(--color-agent-edge)]"
														: "border-line text-ink-soft hover:text-ink"
												}`}
											>
												<input
													type="radio"
													name={`${titleId}-harness`}
													value={h.id}
													checked={pick === h.id}
													onChange={() => choose(h.id)}
													className="h-4 w-4 shrink-0 accent-[var(--color-agent-edge)]"
												/>
												<span className="truncate">{h.label}</span>
											</label>
										))}
									</div>
									{chosen?.install && (
										<Field label="Install">
											<div className="flex min-w-0 gap-1.5">
												<input
													ref={install}
													readOnly
													aria-label="Install"
													value={chosen.install}
													onFocus={(e) => e.currentTarget.select()}
													className={FIELD}
												/>
												<button
													type="button"
													onClick={() => {
														void copyInto(
															chosen.install ?? "",
															install.current,
															setCopied,
														);
													}}
													className={BUTTON}
												>
													<CopyMark copied={copied} />
													{copyWord(copied)}
												</button>
											</div>
										</Field>
									)}
									{chosen?.envHint && (
										<Field label="Env">
											<code className="block min-w-0 truncate rounded-md border border-line bg-code px-3 py-2 font-mono text-xs text-code-ink">
												{chosen.envHint}
											</code>
										</Field>
									)}
									{pick && (
										<div className="grid min-w-0 gap-2 sm:grid-cols-2">
											<Field label="Command">
												<input
													aria-label="Command"
													readOnly={!editable}
													value={command}
													onChange={(e) => setCommand(e.target.value)}
													spellCheck={false}
													autoCapitalize="off"
													className={FIELD}
												/>
											</Field>
											<Field label="Arguments">
												<input
													aria-label="Arguments"
													readOnly={!editable}
													value={args}
													onChange={(e) => setArgs(e.target.value)}
													spellCheck={false}
													autoCapitalize="off"
													className={FIELD}
												/>
											</Field>
										</div>
									)}
								</fieldset>
								<section className="min-w-0 space-y-2">
									<h3 className={STEP}>2 · check</h3>
									<div className="flex min-w-0 flex-wrap items-center gap-2">
										<button
											type="button"
											disabled={!config.command || busy}
											onClick={() => check.mutate(config)}
											className={BUTTON}
										>
											Check
										</button>
										{check.isPending && <Spinner label="Checking" size={14} />}
										{!check.isPending && current?.ok === true && (
											<span
												data-testid="agent-check-ok"
												className="flex min-w-0 items-center gap-1.5 text-sm text-ok"
											>
												<CheckIcon size={16} aria-hidden />
												{current.agent.name} {current.agent.version}
											</span>
										)}
										{!check.isPending && current?.ok === false && (
											<span
												data-testid="agent-check-error"
												role="alert"
												className="flex min-w-0 items-center gap-1.5 text-sm break-words text-bad"
											>
												<XIcon size={16} aria-hidden className="shrink-0" />
												{current.error}
											</span>
										)}
										{check.error && (
											<span role="alert" className="text-sm text-bad">
												{check.error.message}
											</span>
										)}
									</div>
									{!check.isPending &&
										current?.ok === false &&
										current.stderr && (
											<pre className="max-h-40 min-w-0 overflow-auto rounded-md border border-line bg-code px-3 py-2 font-mono text-xs whitespace-pre-wrap text-code-ink">
												{current.stderr}
											</pre>
										)}
								</section>
								<section className="min-w-0 space-y-2">
									<h3 className={STEP}>3 · leash</h3>
									<div className="flex flex-wrap items-center gap-2 text-sm">
										<span
											data-testid="agent-leash"
											className="inline-flex min-h-6 items-center gap-1.5 rounded-full border border-line bg-raised px-2 text-xs text-ink-soft"
										>
											open
											<span
												aria-hidden
												className="h-2 w-2 rounded-full bg-ok"
											/>
										</span>
										<span className="text-faint">stricter levels later</span>
									</div>
								</section>
								{save.error && (
									<p role="alert" className="text-sm text-bad">
										{save.error.message}
									</p>
								)}
							</div>
						)}
					</div>
				)}
				{tab === "launch" && (
					<div className="flex shrink-0 flex-wrap justify-end gap-2 border-t border-line px-4 py-2.5">
						{configured && (
							<button
								type="button"
								disabled={busy}
								onClick={() => save.mutate(null)}
								className={`${BUTTON} mr-auto`}
							>
								{save.isPending && save.variables === null ? (
									<Spinner label="Removing" size={14}>
										Remove
									</Spinner>
								) : (
									"Remove"
								)}
							</button>
						)}
						<button type="button" onClick={onClose} className={BUTTON}>
							Cancel
						</button>
						<button
							type="button"
							disabled={current?.ok !== true || busy}
							onClick={() => save.mutate(config)}
							className={`flex h-10 items-center rounded-md px-4 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-accent ${
								current?.ok === true
									? "cta text-ink hover:brightness-110"
									: "border border-line text-faint"
							}`}
						>
							{save.isPending && save.variables !== null ? (
								<Spinner label="Saving" size={14} />
							) : (
								"Save"
							)}
						</button>
					</div>
				)}
			</TooltipLayer.Provider>
		</dialog>
	);
}

/** The page's one agent setup, opened from anywhere (setupStore.ts). */
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
