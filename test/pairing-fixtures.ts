import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DIFF_ARGS } from "../src/server/diff/files";

/**
 * The gallery's step 2 cases (`pairing/01…07` of
 * Gilthans/carbonless-gallery, branches `base/similarity-pairing` and
 * `case/similarity-pairing`), mirrored byte for byte into
 * test/fixtures/pairing by scripts/pairing-fixtures.mjs. A case's clusters
 * come from git's diff of its two files with the server's arguments
 * (DIFF_ARGS: Myers, indent heuristic, no inter-hunk context) and `-U0`,
 * with the user's git config ignored, so they are the same on every machine.
 */
const DIR = fileURLToPath(new URL("./fixtures/pairing/", import.meta.url));

/** One cluster of a case: the removed lines and the added ones. */
export interface Cluster {
	dels: string[];
	adds: string[];
}

/** The clusters of case `file` (e.g. `05-helper-above.go`), in file order. */
export function pairingClusters(file: string): Cluster[] {
	const args = [
		...DIFF_ARGS,
		"--no-index",
		"-U0",
		"--",
		`${DIR}base/pairing/${file}`,
		`${DIR}case/pairing/${file}`,
	];
	let diff: string;
	try {
		diff = execFileSync("git", args, {
			encoding: "utf8",
			env: {
				...process.env,
				GIT_CONFIG_GLOBAL: "/dev/null",
				GIT_CONFIG_NOSYSTEM: "1",
			},
		});
	} catch (e) {
		// `--no-index` exits 1 when the files differ.
		const err = e as { status?: number; stdout?: string };
		if (err.status !== 1 || err.stdout === undefined) throw e;
		diff = err.stdout;
	}
	const clusters: Cluster[] = [];
	let cluster: Cluster | null = null;
	for (const line of diff.split("\n")) {
		if (line.startsWith("@@")) {
			cluster = { dels: [], adds: [] };
			clusters.push(cluster);
		} else if (cluster && line.startsWith("-"))
			cluster.dels.push(line.slice(1));
		else if (cluster && line.startsWith("+")) cluster.adds.push(line.slice(1));
	}
	return clusters;
}

/** The case's only cluster (fails if it has several). */
export function pairingCluster(file: string): Cluster {
	const clusters = pairingClusters(file);
	if (clusters.length !== 1)
		throw new Error(`${file}: ${clusters.length} clusters, not 1`);
	return clusters[0] as Cluster;
}
