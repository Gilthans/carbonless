/**
 * The default of a switch over a union that handles every member: the
 * compiler checks `value` is `never` (a new member fails the build), and a
 * value that breaks the types at run time throws instead of falling through.
 */
export function unreachable(value: never): never {
	throw new Error(`Unexpected value: ${JSON.stringify(value)}`);
}
