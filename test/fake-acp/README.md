# Fake ACP agent

`agent.mjs` is an ACP agent over stdio, built on `@agentclientprotocol/sdk`'s
`agent()`, that tests spawn in place of the reviewer's harness. Put
`FAKE_ACP_BIN` (`test/fake-acp/bin`, holding an executable named
`claude-agent-acp`, and the `.cmd` shim npm writes beside it on Windows)
first on `PATH`, write a scenario with
`writeAcpScenario(dir, {...})` and pass its path in `CRB_FAKE_ACP`; set
`CRB_FAKE_ACP_LOG` to a file to record every request it receives (with its
`pid`, plus a first `spawn` line with its `cwd`, argv and env names) and
every permission answer it is given, read back with `acpLog(path)`.

The scenario (`scenario.ts`, `AcpScenario`) names the agent, picks answers by
a substring of the latest message (`answers`, split into `chunks`), makes
permission requests before answering (`requests`, one `tool_call` each),
fails `initialize` (`initializeError`: stderr, exit 1) or crashes after the
first chunk (`crashOnPrompt`: exit 70), or closes its stdout there and
lingers (`lingerOnPrompt`). An answer with `stop: "error"` fails the prompt
with its `error` message. `hold: ["prompt"]` keeps a turn
after its first chunk and `hold: ["initialize"]` keeps the handshake, until
`releaseAcp(path, op)`; the fake polls the file every 20 ms, like the fake
gh, so a test gates on its own cue and never on the clock. A
`session/cancel` ends a held turn with `stopReason: "cancelled"`.
