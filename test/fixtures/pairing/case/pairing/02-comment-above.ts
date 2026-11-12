// Request settings.
import { request } from "./http";

export interface Options {
	url: string;
	retries: number;
}

const base = "https://example.test";

// seconds before a request gives up
const timeout = 60;

export function get(path: string) {
	return request(base + path, { timeout });
}
