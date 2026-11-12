#!/usr/bin/env node
import { enableCompileCache } from "node:module";
import { join } from "node:path";
import { cacheDir } from "./server/paths.js";

// Node's compile cache (CAR-105): V8's code for crb's modules, kept between
// runs so a start doesn't compile them again. Turned on before anything
// else loads, hence this small entry and main.js behind it. Node checks
// each entry against its module's source (and keeps a directory per Node
// version), so a new crb or Node never runs stale code from it.
// $NODE_COMPILE_CACHE, when set, has Node turn it on before this runs, and
// $NODE_DISABLE_COMPILE_CACHE keeps it off. A cache that can't be turned on
// (unwritable directory, …) is only slower, never a failed start.
// V8 before 13.7 (Node 24) misreads a `static #method` from it in a class
// of many private names (CAR-136): lint forbids them
// (biome-plugins/no-static-private-method.grit).
try {
	enableCompileCache(join(cacheDir(), "compile-cache"));
} catch {
	// Starts without it.
}

await import("./main.js");
