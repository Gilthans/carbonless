import type { AgentStatus } from "../../../shared/agent";

/**
 * Which view the agent modal shows, from the server's status alone:
 * Connected while a session is joined or this review's spawn flag is set
 * (whatever the runner's state: starting, crashed, elsewhere), Setup
 * otherwise, and a spinner until the status is in.
 */
export function agentView(
	status: AgentStatus | undefined,
): "loading" | "setup" | "connected" {
	if (!status) return "loading";
	return status.joined || status.spawned ? "connected" : "setup";
}
