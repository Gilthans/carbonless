/** The tracer: pure line mapping and position tracing between snapshots. */

export {
	createLineMapper,
	IDENTITY,
	type LineMapper,
	type MapHunk,
} from "./lineMapper.js";
export { type Position, TRACER_VERSION, tracePosition } from "./trace.js";
