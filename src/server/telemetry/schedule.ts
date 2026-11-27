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
	/** Stops the timer and a push under way (its gits killed), waiting a little for it. */
	stop(): Promise<void>;
}

/** How long stop() waits for a stopped push to wind down. */
const STOP_WAIT_MS = 5000;

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
	/** Whether the mailbox is on, as each look found it. */
	onState?: (on: boolean) => void;
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
	let lastTookOver = false;
	const stopping = new AbortController();

	const report = (status: MailboxStatus) => {
		// Once per run of takeovers (two crbs sharing a device name take
		// turns every interval; both would otherwise read "ok").
		const tookOver = status.tookOver === true;
		if (tookOver && !lastTookOver) {
			opts.log(
				`telemetry: device/${status.device} had been written by another crb since this device's last push (another machine with this device name, or a reinstall); taken over`,
			);
		}
		if (status.ok) lastTookOver = tookOver;
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
		opts.onState?.(t !== undefined);
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
		const since = now() - Date.parse(last?.at ?? "");
		// A clock set back (since < 0) makes it due, not stuck until then.
		if (last && sameTarget && since >= 0 && since < t.every * 60_000) {
			return;
		}
		if (stopping.signal.aborted) return;
		const result = await push({
			telemetry: t,
			config,
			traceDir: opts.traceDir(),
			by: "serve",
			now: new Date(now()),
			signal: stopping.signal,
		});
		if (result.status) report(result.status);
	};

	const tick = () => {
		running ??= once()
			.catch((error: unknown) => {
				if (stopping.signal.aborted) return;
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
		stop: async () => {
			if (handle) clearInterval(handle);
			stopping.abort();
			const pending = running;
			if (!pending) return;
			let timer: NodeJS.Timeout | undefined;
			await Promise.race([
				pending,
				new Promise<void>((done) => {
					timer = setTimeout(done, STOP_WAIT_MS);
					timer.unref();
				}),
			]);
			clearTimeout(timer);
		},
	};
}
