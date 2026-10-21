import type { Comparison } from "../shared/types";

async function getJson<T>(path: string): Promise<T> {
	const response = await fetch(path);
	const body = await response.json();
	if (!response.ok) {
		throw new Error(body.error ?? `Request failed: ${response.status}`);
	}
	return body as T;
}

export const fetchComparison = () => getJson<Comparison>("/api/comparison");
