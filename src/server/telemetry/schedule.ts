import type { ConfigRead } from "../config.js";
import {
	type MailboxStatus,
	type PushOptions,
	type PushResult,
	pushMailbox,
	readStatus,
	shownRemote,
} from "./mailbox.js";

/** How often crb serve looks whether a push is due (config read anew). */
const TICK_MS = 60_000;

export interface MailboxTimer {
	/** One look: pushes when due. Resolves once that push ends. */
	tick(): Promise<void>;
	stop(): void;
}

/**
 * crb serve's mailbox: every TICK_MS it reads the config (so `crb telemetry
 * on|off` applies without a restart) and pushes when the last attempt is
 * `every` minutes old, whatever its outcome: a failing remote is tried
 * again an interval later, never in a loop. Off the request path, one push
 * at a time; a failure is logged once per change of outcome, and never
 * stops serving.
 */
export function startMailboxTimer(opts: {
	readConfig: () => Promise<ConfigRead>;
	traceDir: () => string | null;
	log: (message: string) => void;
	now?: () => number;
	push?: (o: PushOptions) => Promise<PushResult>;
	/** Default true; tests call tick() themselves. */
	timer?: boolean;
}): MailboxTimer {
	const now = opts.now ?? Date.now;
	const push = opts.push ?? pushMailbox;
	let running: Promise<void> | null = null;
	let lastOutcome: string | null = null;
	let wasOn = false;

	const report = (status: MailboxStatus) => {
		const outcome = status.ok ? "ok" : `failed: ${status.error ?? "?"}`;
		if (outcome === lastOutcome) return;
		lastOutcome = outcome;
		opts.log(
			status.ok
				? `telemetry: pushed to ${status.mailbox} (device/${status.device})`
				: `telemetry: push to ${status.mailbox} failed, trying again in an interval: ${status.error ?? "?"}`,
		);
	};

	const once = async () => {
		const { config } = await opts.readConfig();
		const t = config.telemetry;
		if (!t) {
			if (wasOn) opts.log("telemetry: off");
			wasOn = false;
			lastOutcome = null;
			return;
		}
		wasOn = true;
		const last = await readStatus();
		const sameTarget =
			last?.device === t.device && last.mailbox === shownRemote(t.mailbox);
		if (last && sameTarget && now() - Date.parse(last.at) < t.every * 60_000) {
			return;
		}
		const result = await push({
			telemetry: t,
			config,
			traceDir: opts.traceDir(),
			by: "serve",
			now: new Date(now()),
		});
		if (result.status) report(result.status);
	};

	const tick = () => {
		running ??= once()
			.catch((error: unknown) => {
				// Never into serving: said once, like a failed push.
				const outcome = `error: ${(error as Error).message}`;
				if (outcome !== lastOutcome) {
					lastOutcome = outcome;
					opts.log(`telemetry: ${outcome}`);
				}
			})
			.finally(() => {
				running = null;
			});
		return running;
	};

	const handle =
		opts.timer === false ? null : setInterval(() => void tick(), TICK_MS);
	handle?.unref();
	return {
		tick,
		stop: () => {
			if (handle) clearInterval(handle);
		},
	};
}
