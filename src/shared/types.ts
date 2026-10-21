export interface CommitInfo {
	sha: string;
	shortSha: string;
	subject: string;
	author: string;
	date: string;
}

export interface Comparison {
	repoPath: string;
	base: CommitInfo;
	head: CommitInfo;
}
