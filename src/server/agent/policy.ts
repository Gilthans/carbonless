import type {
	PermissionOption,
	PermissionOptionKind,
	RequestPermissionRequest,
	RequestPermissionResponse,
} from "@agentclientprotocol/sdk";

/**
 * How tightly carbonless answers the agent's permission requests. `open`,
 * the only level so far, is unleashed: the reviewer's own harness is the
 * gate (docs/superpowers/specs/2026-11-04-review-buddy-design.md, "The
 * leash"). A stricter level is more rows in decidePermission.
 */
export type Leash = "open";

export interface Decision {
	response: RequestPermissionResponse;
	decision: "allowed" | "rejected";
	reason?: string;
}

const PLAN = /\bplan\b/i;
const PLAN_REASON = "carbonless keeps the session out of plan mode";

/** Whether a switch_mode request goes into a plan mode: any string in rawInput, or the title. */
function intoPlan(req: RequestPermissionRequest): boolean {
	const { title, rawInput } = req.toolCall;
	if (typeof title === "string" && PLAN.test(title)) return true;
	const strings: string[] = [];
	const walk = (v: unknown, depth: number) => {
		if (typeof v === "string") strings.push(v);
		else if (depth < 4 && v && typeof v === "object")
			for (const x of Object.values(v)) walk(x, depth + 1);
	};
	walk(rawInput, 0);
	return strings.some((s) => PLAN.test(s));
}

const pick = (
	options: PermissionOption[],
	kinds: PermissionOptionKind[],
): PermissionOption | undefined => {
	for (const kind of kinds) {
		const found = options.find((o) => o.kind === kind);
		if (found) return found;
	}
	return undefined;
};

const selected = (o: PermissionOption): RequestPermissionResponse => ({
	outcome: { outcome: "selected", optionId: o.optionId },
});
const CANCELLED: RequestPermissionResponse = {
	outcome: { outcome: "cancelled" },
};

/**
 * carbonless's answer to one `session/request_permission`. At `open`: every
 * kind is allowed (`allow_once`, else `allow_always`, else the first
 * option), except a `switch_mode` into a plan mode, which is rejected
 * (`reject_once`, else `reject_always`). No option that fits: cancelled.
 */
export function decidePermission(
	req: RequestPermissionRequest,
	_leash: Leash,
): Decision {
	const options = req.options ?? [];
	if (req.toolCall.kind === "switch_mode" && intoPlan(req)) {
		const reject = pick(options, ["reject_once", "reject_always"]);
		return {
			response: reject ? selected(reject) : CANCELLED,
			decision: "rejected",
			reason: PLAN_REASON,
		};
	}
	const allow = pick(options, ["allow_once", "allow_always"]) ?? options[0];
	if (!allow) return { response: CANCELLED, decision: "rejected" };
	return {
		response: selected(allow),
		decision: allow.kind.startsWith("allow") ? "allowed" : "rejected",
	};
}
