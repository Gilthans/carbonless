/** Puts Ask agent in every selection's bar, after Comment. App imports it once. */
import { registerSelectionAction } from "../files/selectionActions";
import { ASK_AGENT_ACTION } from "./askAgentAction";

registerSelectionAction(ASK_AGENT_ACTION);
