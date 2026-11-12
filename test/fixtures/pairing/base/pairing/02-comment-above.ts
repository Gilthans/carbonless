// Request settings.
import { request } from "./http";

export interface Options {
	url: string;
	retries: number;
}

const base = "https://example.test";

const timeout = 30;

export function get(path: string) {
	return request(base + path, { timeout });
}
