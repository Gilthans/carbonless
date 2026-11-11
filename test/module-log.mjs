// Preloaded (`node --import`) by src/cli.test.ts: appends every module the
// process loads (its URL, one per line) to $CRB_MODULE_LOG, as it loads.
import { appendFileSync } from "node:fs";
import { registerHooks } from "node:module";

const log = process.env.CRB_MODULE_LOG;
if (log) {
	registerHooks({
		load(url, context, next) {
			appendFileSync(log, `${url}\n`);
			return next(url, context);
		},
	});
}
