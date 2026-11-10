// The fake gh's span (docs/test-profiling.md): one per call, from this
// process's start to its exit, under $TRACEPARENT (crb's span of the call),
// in a file of its own in $CRB_TRACE_DIR. Plain JS and no imports beyond
// node: a fake gh starts for every call, and loading src/server/trace.ts
// (type stripping) would cost more than the call. The format is trace.ts's
// otlpLine; src/server/trace.test.ts checks the two agree.
import { writeFileSync } from "node:fs";
import { join } from "node:path";

/** `n` random hex digits; Math.random spares loading node:crypto per call. */
const hex = (n) =>
	Array.from({ length: n }, () => ((Math.random() * 16) | 0).toString(16)).join(
		"",
	);

/** Records this call's span at exit when $CRB_TRACE_DIR is set. */
export function traceCall(args) {
	const dir = process.env.CRB_TRACE_DIR;
	if (!dir) return;
	const m = /^00-([0-9a-f]{32})-([0-9a-f]{16})-/.exec(
		process.env.TRACEPARENT ?? "",
	);
	// Not `performance`: its first touch costs ~1.5 ms of CPU a call, and
	// milliseconds are enough for a process's span.
	const start = Date.now() - process.uptime() * 1000;
	process.on("exit", (code) => {
		const end = Date.now();
		const nanos = (ms) =>
			`${Math.floor(ms)}${String(Math.min(999999, Math.round((ms % 1) * 1e6))).padStart(6, "0")}`;
		const short = args
			.map((a) => (a.length > 40 ? `${a.slice(0, 39)}…` : a))
			.join(" ");
		const attr = (key, value) => ({
			key,
			value:
				typeof value === "string"
					? { stringValue: value }
					: { intValue: value },
		});
		const line = JSON.stringify({
			resourceSpans: [
				{
					resource: {
						attributes: [
							attr("service.name", "fake-gh"),
							attr("process.pid", process.pid),
							...(process.env.CRB_TRACE_RUN
								? [attr("crb.run", process.env.CRB_TRACE_RUN)]
								: []),
						],
					},
					scopeSpans: [
						{
							scope: { name: "carbonless" },
							spans: [
								{
									traceId: m?.[1] ?? hex(32),
									spanId: hex(16),
									...(m ? { parentSpanId: m[2] } : {}),
									name: `fake gh ${args.slice(0, 2).join(" ")}`.slice(0, 60),
									kind: 1,
									startTimeUnixNano: nanos(start),
									endTimeUnixNano: nanos(end),
									attributes: [
										attr(
											"args",
											short.length > 160 ? `${short.slice(0, 159)}…` : short,
										),
										attr("exit", code),
									],
								},
							],
						},
					],
				},
			],
		});
		try {
			writeFileSync(
				join(dir, `fake-gh-${process.pid}-${hex(6)}.jsonl`),
				`${line}\n`,
			);
		} catch {
			// A trace that can't be written never fails the call.
		}
	});
}
