/*
 * Whether the server that served this page traces (its `crb-trace` meta,
 * src/server/browserTrace.ts). The only part of the page's spans loaded
 * when it doesn't: main.tsx imports the rest (install.ts) on demand.
 */
export function tracingOn(doc: Document = document): boolean {
	return (
		doc.querySelector('meta[name="crb-trace"]')?.getAttribute("content") === "1"
	);
}
