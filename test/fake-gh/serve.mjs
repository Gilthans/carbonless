// The fake gh server (server.mjs starts it in a worker thread of the test
// process): runs each call test/fake-gh/gh forwards as fakeGh(io) (gh.mjs),
// with a gh process's semantics. Calls run side by side: a held one waits
// in an async sleep, never blocking the others.
//
// Request (the shim's), NUL-terminated fields: its pid, cwd, "1" when stdin
// follows, argc, the args, NAME=value per environment variable, an empty
// field, then stdin when it follows. Answer: "<code> <stderr bytes> <stdout
// bytes>\n", stderr, stdout. The shim closing first means it was killed:
// the call ends at its next wait (sleep) and nothing is answered.
import { createServer } from "node:net";
import { workerData } from "node:worker_threads";
import { fakeGh } from "./gh.mjs";
import { writeSpan } from "./trace.mjs";

/** The request in `fields` once complete, else null. */
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

async function serve(socket, req, start, closed) {
	Atomics.add(state, 2, 1);
	Atomics.add(state, 3, 1);
	try {
		await answer(socket, req, start, closed);
	} finally {
		Atomics.sub(state, 3, 1);
	}
}

async function answer(socket, req, start, closed) {
	const out = [];
	const err = [];
	const code = await fakeGh({
		args: req.args,
		env: req.env,
		cwd: req.cwd,
		stdin: () => req.stdin,
		out: (text) => out.push(text),
		err: (text) => err.push(text),
		killed: closed,
	});
	// A killed gh process writes no span either.
	if (closed()) return;
	writeSpan({
		env: req.env,
		args: req.args,
		pid: req.pid,
		start,
		end: Date.now(),
		code,
	});
	const o = Buffer.from(out.join(""));
	const e = Buffer.from(err.join(""));
	socket.end(
		Buffer.concat([Buffer.from(`${code} ${e.length} ${o.length}\n`), e, o]),
	);
}

const server = createServer((socket) => {
	const start = Date.now();
	const fields = [];
	let rest = Buffer.alloc(0);
	let started = false;
	let gone = false;
	// The shim never half-closes: its end is its death.
	const die = () => {
		gone = true;
	};
	socket.on("end", die);
	socket.on("close", die);
	socket.on("error", () => {});
	socket.on("data", (chunk) => {
		if (started) return;
		rest = rest.length ? Buffer.concat([rest, chunk]) : chunk;
		for (let i = rest.indexOf(0); i !== -1; i = rest.indexOf(0)) {
			fields.push(rest.subarray(0, i).toString("utf8"));
			rest = rest.subarray(i + 1);
		}
		const req = request(fields);
		if (!req) return;
		started = true;
		serve(socket, req, start, () => gone).catch((error) => {
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
