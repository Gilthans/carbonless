import { existsSync } from "node:fs";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import type { Comparison } from "../shared/types.js";
import { GitError, getCommit } from "./git.js";

export interface AppOptions {
	repoPath: string;
	base: string;
	head: string;
	/** Directory with the built web UI. Omit to serve only the API. */
	webRoot?: string;
	logger?: boolean;
}

export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
	const app = Fastify({ logger: options.logger ?? false });

	app.setErrorHandler((error, _request, reply) => {
		if (error instanceof GitError) {
			return reply.status(400).send({ error: error.message });
		}
		app.log.error(error);
		return reply.status(500).send({ error: "Internal server error" });
	});

	app.get("/api/comparison", async (): Promise<Comparison> => {
		const [base, head] = await Promise.all([
			getCommit(options.repoPath, options.base),
			getCommit(options.repoPath, options.head),
		]);
		return { repoPath: options.repoPath, base, head };
	});

	if (options.webRoot && existsSync(options.webRoot)) {
		await app.register(fastifyStatic, { root: options.webRoot });
		app.setNotFoundHandler((request, reply) => {
			if (request.url.startsWith("/api/")) {
				return reply.status(404).send({ error: "Not found" });
			}
			return reply.sendFile("index.html");
		});
	}

	return app;
}
