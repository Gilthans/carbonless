import { InfoIcon, SparkleFillIcon, XIcon } from "@primer/octicons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import type { AgentCheck, AgentConfig } from "../../../shared/agent";
import {
	AGENT_HARNESSES,
	type AgentHarness,
} from "../../../shared/agentHarnesses";
import { Spinner, SpinnerIcon } from "../../Spinner";
import { Tooltip } from "../../Tooltip";
import {
	agentConfigQuery,
	agentStatusQuery,
	checkAgentConfig,
	postAgentStart,
	putAgentConfig,
} from "../api";
import { formatArgs, parseArgs } from "../args";
import {
	CopyRow,
	ErrorLine,
	FIELD,
	Field,
	PICK,
	PICKED,
	Step,
	UNPICKED,
} from "./parts";

type HarnessId = AgentHarness["id"];

const harness = (id: HarnessId | null) =>
	AGENT_HARNESSES.find((h) => h.id === id);

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

/**
 * The config the fields say. The env and leash config.json has for this
 * command go along unchanged (a hand-written env must survive); another
 * command starts with none.
 */
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

/** What the leash's info says. */
export const LEASH_TIP =
	"Allows anything the local session allows. Stricter leashes are coming.";

/** What a Spawn press came to: the check's refusal, or started. */
type SpawnResult = { started: true } | { started: false; check: AgentCheck };

/**
 * Spawn: this review's own ACP agent. Step 1 picks the harness (its
 * install line, copyable; Other is typed), step 2 the leash (Open only),
 * step 3 the command, and Spawn: the config is checked, and only if it
 * runs is it saved and this review's agent started. The view moves to
 * Connected once the status says the flag is set.
 */
export function SpawnTab() {
	const client = useQueryClient();
	const stored = useQuery(agentConfigQuery);
	// A fresh read seeds the form; a later refetch keeps it.
	const fresh = stored.isSuccess && !stored.isFetching ? stored.data : null;
	const read = stored.data ?? null;
	const radioName = useId();
	const [pick, setPick] = useState<HarnessId | null>(null);
	const [command, setCommand] = useState("");
	const [args, setArgs] = useState("");
	// The form starts from config.json once it is read: the harness whose
	// command and arguments it has (else Other with them), Claude Code
	// when none is set up.
	const shownFor = useRef<unknown>(null);
	useEffect(() => {
		if (!fresh || shownFor.current) return;
		shownFor.current = fresh;
		const agent = fresh.agent;
		const preset = agent ? presetOf(agent) : harness("claude-code");
		setPick(preset?.id ?? "other");
		// A stored command is kept as written (an absolute path included).
		setCommand(agent?.command ?? preset?.command ?? "");
		setArgs(formatArgs(preset?.args ?? agent?.args ?? []));
	}, [fresh]);
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
	};
	const config = configOf(command, args, read?.agent);
	const inFlight = useRef(false);
	const spawn = useMutation({
		mutationFn: async (c: AgentConfig): Promise<SpawnResult> => {
			const check = await checkAgentConfig(c);
			if (!check.ok) return { started: false, check };
			await putAgentConfig(c);
			await postAgentStart();
			return { started: true };
		},
		onSettled: (result) => {
			if (result && !result.started) return;
			void client.invalidateQueries({ queryKey: agentStatusQuery.queryKey });
			void client.invalidateQueries({ queryKey: agentConfigQuery.queryKey });
		},
	});
	const press = () => {
		// Set at once: a second press before the re-render does nothing.
		if (inFlight.current || !config.command) return;
		inFlight.current = true;
		spawn.mutate(config, {
			onSettled: (result) => {
				// Started: it stays "Spawning…" until the view moves.
				if (!result?.started) inFlight.current = false;
			},
		});
	};
	const refused =
		spawn.data && !spawn.data.started && !spawn.data.check.ok
			? spawn.data.check
			: null;
	const spawning = spawn.isPending || spawn.data?.started === true;
	const chosen = harness(pick);
	const editable = pick === "other";
	return (
		<>
			<p className="text-sm text-ink-soft">
				Spawn a session to serve as your review agent
			</p>
			{!read || pick === null ? (
				<div aria-busy="true" className="py-4">
					{stored.isError ? (
						<ErrorLine>{stored.error.message}</ErrorLine>
					) : (
						<Spinner label="Loading your agent's config" />
					)}
				</div>
			) : (
				<>
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
					<Step n={1} title="One-time setup">
						<div
							role="radiogroup"
							aria-label="Harness"
							className="grid grid-cols-2 gap-1.5 sm:grid-cols-3"
						>
							{AGENT_HARNESSES.map((h) => (
								<label
									key={h.id}
									className={`${PICK} ${pick === h.id ? PICKED : UNPICKED}`}
								>
									<input
										type="radio"
										name={`${radioName}-harness`}
										value={h.id}
										checked={pick === h.id}
										onChange={() => choose(h.id)}
										className="size-4 shrink-0 accent-[var(--color-agent-edge)]"
									/>
									<span className="truncate">{h.label}</span>
								</label>
							))}
						</div>
						{chosen?.install && (
							<CopyRow
								label="Install"
								testId="agent-install-line"
								value={chosen.install}
							/>
						)}
					</Step>
					<Step n={2} title="Select leash">
						<div className="flex min-w-0 items-center gap-1.5">
							<div role="radiogroup" aria-label="Leash" className="flex">
								<label className={`${PICK} ${PICKED}`}>
									<input
										type="radio"
										name={`${radioName}-leash`}
										value="open"
										checked
										readOnly
										aria-describedby={`${radioName}-leash-tip`}
										className="size-4 shrink-0 accent-[var(--color-agent-edge)]"
									/>
									Open
									<span
										aria-hidden
										className="size-2 shrink-0 rounded-full bg-ok"
									/>
								</label>
							</div>
							<span id={`${radioName}-leash-tip`} className="sr-only">
								{LEASH_TIP}
							</span>
							<Tooltip content={LEASH_TIP} describe={false}>
								{(trigger) => (
									<button
										type="button"
										{...trigger}
										aria-label={LEASH_TIP}
										data-testid="agent-leash-info"
										className="flex size-10 shrink-0 cursor-help items-center justify-center rounded-md text-muted hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
									>
										<InfoIcon size={16} aria-hidden />
									</button>
								)}
							</Tooltip>
						</div>
					</Step>
					<Step n={3} title="Configure">
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
						<div className="flex justify-end">
							<button
								type="button"
								data-testid="agent-spawn"
								aria-disabled={!config.command || spawning || undefined}
								onClick={press}
								className="flex h-10 items-center gap-2 rounded-md bg-agent-edge px-4.5 text-sm font-semibold text-ink hover:brightness-110 focus-visible:outline-2 focus-visible:outline-accent aria-disabled:opacity-60"
							>
								{spawning ? (
									<SpinnerIcon size={14} />
								) : (
									<SparkleFillIcon size={14} aria-hidden />
								)}
								{spawning ? "Spawning…" : "Spawn"}
							</button>
						</div>
						{refused && (
							<>
								<p
									data-testid="agent-check-error"
									role="alert"
									className="flex min-w-0 items-center gap-1.5 text-sm break-words text-bad"
								>
									<XIcon size={16} aria-hidden className="shrink-0" />
									{refused.error}
								</p>
								{refused.stderr && (
									<pre className="max-h-40 min-w-0 overflow-auto rounded-md border border-line bg-code px-3 py-2 font-mono text-xs whitespace-pre-wrap text-code-ink">
										{refused.stderr}
									</pre>
								)}
							</>
						)}
						{spawn.error && <ErrorLine>{spawn.error.message}</ErrorLine>}
					</Step>
				</>
			)}
		</>
	);
}
