/** The tracer: pure line mapping and position tracing between snapshots. */

export {
	createLineMapper,
	IDENTITY,
	type LineMapper,
	type MapHunk,
} from "./lineMapper.js";
export {
	type Placement,
	type Position,
	TRACER_VERSION,
	type TraceDiffs,
	tracePosition,
	traceRange,
	traceSpan,
} from "./trace.js";
