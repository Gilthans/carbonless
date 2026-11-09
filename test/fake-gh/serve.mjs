// The fake gh server (server.mjs starts it in a worker thread of the test
// process): runs each call test/fake-gh/gh forwards as fakeGh(io) (gh.mjs),
// with a gh process's semantics. Calls run side by side: a held one waits
// in an async sleep, never blocking the others.
//
// Request (the shim's), NUL-terminated fields: the server's token (from
// $CRB_FAKE_GH_SERVER; any other closes the connection), its pid, cwd, "1" when stdin
// follows, argc, the args, NAME=value per environment variable, an empty
// field, then stdin when it follows. Answer: "<code> <stderr bytes> <stdout
// bytes>\n", stderr, stdout; before it, with $CRB_FAKE_GH_LOG set, "log\n",
// which the shim answers "k" once it has appended the call to the log. The
// shim closing first means it was killed: the call ends at its next wait
// (sleep, log) and nothing is answered.
import { createServer } from "node:net";
import { resolve } from "node:path";
import { workerData } from "node:worker_threads";
import { fakeGh } from "./gh.mjs";
import { writeSpan } from "./trace.mjs";

/** The request in `fields` (after the token) once complete, else null. */
function request(fields) {
	if (fields.length < 4) return null;
	const argc = Number(fields[3]);
	const envEnd = fields.indexOf("", 4 + argc);
	if (envEnd === -1) return null;
	const input = fields[2] === "1";
	if (input && fields.length < envEnd + 2) return null;
	const env = {};
	for (const entry of fields.slice(4 + argc, envEnd)) {
		const eq = entry.indexOf("=");
		env[entry.slice(0, eq)] = entry.slice(eq + 1);
	}
	return {
		pid: Number(fields[0]),
		cwd: fields[1],
		args: fields.slice(4, 4 + argc),
		env,
		stdin: input ? fields[envEnd + 1] : "",
	};
}

/**
 * A shim's connection: `gone` once it closed (the shim never half-closes:
 * its end is its death), `acks` the log() calls waiting for its "k".
 */
class Conn {
	gone = false;
	acks = [];
	constructor(socket) {
		this.socket = socket;
	}
	die() {
		this.gone = true;
		for (const ack of this.acks.splice(0)) ack(false);
	}
	/**
	 * Has the shim append the call to the log, and waits for its "k": a log
	 * line is written only by a gh still alive, as with a process (a test
	 * reads the log after killing gh, and nothing may appear in it later).
	 */
	log() {
		if (this.gone) return false;
		this.socket.write("log\n");
		return new Promise((resolve) => this.acks.push(resolve));
	}
}

async function serve(conn, req, start) {
	Atomics.add(state, 2, 1);
	Atomics.add(state, 3, 1);
	try {
		await answer(conn, req, start);
	} finally {
		Atomics.sub(state, 3, 1);
	}
}

async function answer(conn, req, start) {
	// A shim killed right after sending its call never starts it, as a
	// process killed before its first line: an end already on the socket
	// is taken in first.
	await new Promise((resolve) => setImmediate(resolve));
	if (conn.gone) return;
	const out = [];
	const err = [];
	const code = await fakeGh({
		args: req.args,
		env: req.env,
		cwd: req.cwd,
		stdin: () => req.stdin,
		out: (text) => out.push(text),
		err: (text) => err.push(text),
		log: () => conn.log(),
		killed: () => conn.gone,
	});
	// A killed gh process writes no span either.
	if (conn.gone) return;
	writeSpan({
		env: req.env.CRB_TRACE_DIR
			? { ...req.env, CRB_TRACE_DIR: resolve(req.cwd, req.env.CRB_TRACE_DIR) }
			: req.env,
		args: req.args,
		pid: req.pid,
		start,
		end: Date.now(),
		code,
	});
	const o = Buffer.from(out.join(""));
	const e = Buffer.from(err.join(""));
	conn.socket.end(
		Buffer.concat([Buffer.from(`${code} ${e.length} ${o.length}\n`), e, o]),
	);
}

const server = createServer((socket) => {
	const start = Date.now();
	const conn = new Conn(socket);
	const fields = [];
	let rest = Buffer.alloc(0);
	let started = false;
	let received = 0;
	socket.on("end", () => conn.die());
	socket.on("close", () => conn.die());
	socket.on("error", () => {});
	socket.on("data", (chunk) => {
		if (started) {
			// The shim's "k" per log line written.
			for (const byte of chunk) if (byte === 0x6b) conn.acks.shift()?.(true);
			return;
		}
		received += chunk.length;
		rest = rest.length ? Buffer.concat([rest, chunk]) : chunk;
		for (let i = rest.indexOf(0); i !== -1; i = rest.indexOf(0)) {
			fields.push(rest.subarray(0, i).toString("utf8"));
			rest = rest.subarray(i + 1);
		}
		// Only a shim of this test process (it has the token from
		// $CRB_FAKE_GH_SERVER) may run a call: its input picks files to read
		// and write and git's environment. Nor may a request grow forever.
		const stranger =
			fields.length > 0
				? fields[0] !== workerData.token
				: rest.length > workerData.token.length;
		if (stranger || received > workerData.maxRequest) {
			started = true;
			socket.destroy();
			return;
		}
		const req = request(fields.slice(1));
		if (!req) return;
		started = true;
		serve(conn, req, start).catch((error) => {
			socket.destroy(error);
		});
	});
});

/** server.mjs's: [status, port, calls served, calls running]. */
const state = new Int32Array(workerData.state);
const ready = (status, port = 0) => {
	Atomics.store(state, 1, port);
	Atomics.store(state, 0, status);
	Atomics.notify(state, 0);
};
server.on("error", () => ready(2));
server.listen(0, "127.0.0.1", () => ready(1, server.address().port));
