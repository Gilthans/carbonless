import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { JOIN, JOINED_PREAMBLE } from "../../shared/agent.js";
import {
	type AgentHost,
	BadReplyError,
	NotHandedError,
	SessionTokenError,
} from "../agent/host.js";
import { UnknownAgentThreadError } from "../agent/store.js";
import {
	RefusedReviewError,
	type SessionRegistry,
	UnknownReviewError,
} from "../registry.js";
import { BUILD } from "../version.js";
import type { JoinableReview } from "./reviews.js";
import {
	parseSessionToken,
	REVIEW_ID,
	sessionToken,
	UnsafeKeyError,
	watchCommand,
} from "./watch.js";

/**
 * crb's MCP tools: a session carbonless didn't launch finds a review
 * (`reviews`), asks to join it (`attach`, the reviewer approves), then
 * answers its agent threads (`next`, `reply`) until it leaves (`detach`).
 * Every tool but `reviews` and `attach` needs the token an approved
 * `attach` hands out. Spec: the CAR-81 ticket's spec document.
 */

/** What one MCP request knows of where it came from. */
export interface McpRequestContext {
	/** This server as the session reached it (checked: isSafeOrigin). */
	origin: string;
	/** The access key the watcher's URL carries; null on a keyless server. */
	key: string | null;
	/** The request's remote address: `machine` when the session names none. */
	remote: string;
}

export interface McpDeps {
	registry: Pick<SessionRegistry, "get" | "peek" | "touch">;
	/**
	 * Whether review `id` may have a joined session (its joined.json): a
	 * token for a review that isn't open opens it only then.
	 */
	joinedOnDisk(id: string): boolean;
	reviews(origin: string, query?: string): Promise<JoinableReview[]>;
}

/** A tool's refusal, with the code the tools' contract names. */
export class ToolError extends Error {
	constructor(
		readonly code:
			| "invalid"
			| "unknown-review"
			| "refused"
			| "no-agent"
			| "elsewhere"
			| "unknown-token"
			| "not-handed"
			| "unknown-thread"
			| "bad-key",
		message: string,
	) {
		super(message);
	}
}

const JOIN_REQUEST = /^[0-9a-hjkmnp-tv-z]{26}$/;
const IDENTITY = z.string().max(1000);

const ok = (value: unknown): CallToolResult => ({
	content: [{ type: "text", text: JSON.stringify(value) }],
});

const fail = (code: string, message: string): CallToolResult => ({
	isError: true,
	content: [{ type: "text", text: JSON.stringify({ error: code, message }) }],
});

/** A tool's body, its known refusals as `{error, message}`. */
async function run(body: () => Promise<unknown>): Promise<CallToolResult> {
	try {
		return ok(await body());
	} catch (error) {
		if (error instanceof ToolError) return fail(error.code, error.message);
		if (error instanceof SessionTokenError) {
			return fail("unknown-token", error.message);
		}
		if (error instanceof NotHandedError) {
			return fail("not-handed", error.message);
		}
		if (error instanceof BadReplyError) return fail("invalid", error.message);
		if (error instanceof UnknownAgentThreadError) {
			return fail("unknown-thread", error.message);
		}
		if (error instanceof UnknownReviewError) {
			return fail("unknown-review", error.message);
		}
		if (error instanceof RefusedReviewError) {
			return fail("refused", error.message);
		}
		throw error;
	}
}

/** The review id in a review's link (`…/r/<id>…`) or a bare id. */
export function reviewIdOf(review: string): string | null {
	const text = review.trim();
	if (REVIEW_ID.test(text)) return text;
	let path: string;
	try {
		path = new URL(text).pathname;
	} catch {
		return null;
	}
	const m = /^\/r\/([0-9a-hjkmnp-tv-z]{26})(\/|$)/.exec(path);
	return m ? (m[1] as string) : null;
}

/** One MCP server for one request (the transport is stateless). */
export function createMcpServer(
	deps: McpDeps,
	ctx: McpRequestContext,
): McpServer {
	const server = new McpServer({
		name: "carbonless",
		version: BUILD.version,
	});
	const link = (id: string) => `${ctx.origin}/r/${id}`;

	const hostOf = async (id: string): Promise<AgentHost> => {
		const session = await deps.registry.get(id);
		if (!session.agent) {
			throw new ToolError(
				"no-agent",
				"This review has no buddy: it is a view as of a past moment or as another reviewer",
			);
		}
		return session.agent;
	};
	/** The token's review and secret; unknown-token for anything else. */
	const tokenHost = async (
		token: string,
	): Promise<{ host: AgentHost; secret: string; id: string }> => {
		const parsed = parseSessionToken(token);
		if (!parsed) throw new SessionTokenError();
		// Only attach opens a review: a token opens one only if a session
		// is joined to it on disk (a crb restart since the join).
		const open = deps.registry.peek(parsed.id);
		if (!open && !deps.joinedOnDisk(parsed.id)) {
			throw new SessionTokenError();
		}
		let host: AgentHost;
		try {
			host = open?.agent ?? (await hostOf(parsed.id));
		} catch (error) {
			if (error instanceof UnknownReviewError || error instanceof ToolError) {
				throw new SessionTokenError();
			}
			throw error;
		}
		// A use of the review only once the token checks out.
		if (!(await host.sessionAllowed(parsed.secret))) {
			throw new SessionTokenError();
		}
		deps.registry.touch(parsed.id);
		return { host, secret: parsed.secret, id: parsed.id };
	};
	const TOKEN = {
		token: z
			.string()
			.describe("The token an approved attach returned (this review only)"),
	};

	server.registerTool(
		"reviews",
		{
			description:
				"List the reviewer's carbonless reviews, newest activity first (repo, PR, title, branch, state, progress, who answers its questions). Use it to find the review the reviewer asked you to join, then call attach with its link.",
			inputSchema: {
				query: z
					.string()
					.max(200)
					.optional()
					.describe("Filter on repo, title, branch or #number"),
			},
		},
		({ query }) =>
			run(async () => ({ reviews: await deps.reviews(ctx.origin, query) })),
	);

	server.registerTool(
		"attach",
		{
			description:
				"Ask to join a carbonless review as its review buddy (you answer the reviewer's questions about the PR). The reviewer must approve every join: tell them to open the review's link and press Approve, then call attach again with the `request` it returned (it waits up to 20 s for the answer). Once approved, follow its `instructions`.",
			inputSchema: {
				review: z
					.string()
					.max(2000)
					.describe("The review's link (…/r/<id>), as reviews lists it"),
				name: IDENTITY.describe(
					"How you name yourself to the reviewer, e.g. your working directory and branch",
				),
				machine: IDENTITY.optional().describe("Your machine's hostname"),
				harness: IDENTITY.optional().describe(
					"Your harness and its version, e.g. Claude Code 2.1",
				),
				request: z
					.string()
					.max(100)
					.optional()
					.describe("The request id an earlier attach returned"),
			},
		},
		(args) =>
			run(async () => {
				const id = reviewIdOf(args.review);
				if (!id) {
					throw new ToolError(
						"invalid",
						"review must be a review's link (…/r/<id>): call reviews to find it",
					);
				}
				// The token goes out once: the watcher's line must be
				// buildable before a join is even asked for.
				try {
					watchCommand(
						ctx.origin,
						id,
						sessionToken(id, "A".repeat(43)),
						ctx.key,
					);
				} catch (error) {
					throw new ToolError(
						error instanceof UnsafeKeyError ? "bad-key" : "invalid",
						(error as Error).message,
					);
				}
				const host = await hostOf(id);
				const where = link(id);
				if (args.request !== undefined) {
					if (!JOIN_REQUEST.test(args.request)) {
						throw new ToolError("invalid", "Not a join request id");
					}
					const o = await host.join.outcome(args.request, JOIN.attachWaitMs);
					if (o.state === "pending") {
						return {
							state: "pending",
							request: o.request,
							message: `Still waiting for the reviewer. Ask them to open ${where} and press Approve, then call attach again with request ${o.request}.`,
						};
					}
					if (o.state === "denied") {
						return {
							state: "denied",
							message:
								"The reviewer denied this join. Don't ask again unless they tell you to.",
						};
					}
					if (o.state !== "approved") {
						return {
							state: "expired",
							message:
								"This request is no longer pending (expired, replaced, or its token already collected). Call attach without request to ask again.",
						};
					}
					const token = sessionToken(id, o.token);
					const watch = watchCommand(ctx.origin, id, token, ctx.key);
					// The token is collected: nothing after this may lose it.
					let review: Record<string, unknown> | null = null;
					let waiting: number | null = null;
					try {
						review = {
							link: where,
							...(await host.sessionReview(o.token, true)),
						};
						waiting = await host.sessionWaiting();
					} catch (error) {
						console.warn(`crb: attach: ${(error as Error).message}`);
					}
					return {
						state: "approved",
						preamble: JOINED_PREAMBLE,
						instructions: `You are this review's buddy now. 1) Run \`watch\` as a background shell command (it exits when a question waits for you, or when you are detached). 2) Call next; answer the question it gives with reply (thread, replyTo, your answer in Markdown); call next again until it says none waits. 3) When watch exits, read its line, then repeat from 2 and run watch again. Call detach when you stop. Keep the token to yourself: it is this review's only.${review ? "" : " The review's facts couldn't be read just now: call review for them."}`,
						token,
						watch,
						waiting,
						review,
					};
				}
				const claim = await host.join.claimCheck();
				if (!claim.ok) {
					throw new ToolError(
						"elsewhere",
						`Another carbonless server on the reviewer's machine (port ${claim.holder.port}) holds this review's buddy: add that server's /mcp (same host, port ${claim.holder.port}) and attach there.`,
					);
				}
				const machine = args.machine?.trim() || ctx.remote;
				const { request } = host.join.request({
					name: args.name,
					machine,
					...(args.harness ? { harness: args.harness } : {}),
				});
				return {
					state: "pending",
					request,
					message: `The reviewer must approve this connection in carbonless. Ask them to open ${where} and press Approve, then call attach again with request ${request}.`,
				};
			}),
	);

	server.registerTool(
		"next",
		{
			description:
				"The oldest question waiting for you (preamble, envelope, the anchored file and the diff hunk), handed to you until you reply; the same one again if you call it before replying. `{none: true}` when nothing waits: then run watch in the background.",
			inputSchema: TOKEN,
		},
		({ token }) =>
			run(async () => {
				const { host, secret } = await tokenHost(token);
				return (await host.sessionNext(secret)) ?? { none: true };
			}),
	);

	server.registerTool(
		"reply",
		{
			description:
				"Answer the question next handed you: thread and replyTo as next gave them, text in GitHub-flavored Markdown (up to 32 KiB). Then call next again; when it says none, run watch.",
			inputSchema: {
				...TOKEN,
				thread: z.string().max(100),
				replyTo: z.string().max(100),
				text: z.string().max(1_000_000),
			},
		},
		({ token, thread, replyTo, text }) =>
			run(async () => {
				const { host, secret } = await tokenHost(token);
				const t = await host.sessionReply(secret, { thread, replyTo, text });
				return { ok: true, thread: t.id, waiting: t.waiting };
			}),
	);

	server.registerTool(
		"threads",
		{
			description:
				"Every agent thread on the review, with its messages (yours included), to reread one.",
			inputSchema: TOKEN,
		},
		({ token }) =>
			run(async () => {
				const { host, secret } = await tokenHost(token);
				return { threads: await host.sessionThreads(secret) };
			}),
	);

	server.registerTool(
		"review",
		{
			description:
				"The review's facts again: repo, PR, base and head commits (the head may have moved), title, body and files.",
			inputSchema: TOKEN,
		},
		({ token }) =>
			run(async () => {
				const { host, secret, id } = await tokenHost(token);
				return {
					preamble: JOINED_PREAMBLE,
					review: {
						link: link(id),
						...(await host.sessionReview(secret, true)),
					},
				};
			}),
	);

	server.registerTool(
		"detach",
		{
			description:
				"Leave the review: your token stops working and the watcher ends. The reviewer sees that you left.",
			inputSchema: TOKEN,
		},
		({ token }) =>
			run(async () => {
				const { host, secret } = await tokenHost(token);
				await host.sessionDetach(secret);
				return { ok: true };
			}),
	);

	return server;
}
