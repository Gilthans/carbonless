type Env = Record<string, string | undefined>;
export function ghConfigDir(env?: Env): string;
export function privateDirs(
	dir: string,
	env?: Env,
): {
	XDG_STATE_HOME: string;
	XDG_CONFIG_HOME: string;
	GH_CONFIG_DIR: string;
};
export function envrc(dir: string, env?: Env): string;
export function writePrivateConfig(dir: string, port: number): void;
export function removeStaleState(dir: string): void;
export function waitForLiveServer(
	port: number,
	timeoutMs: number,
): Promise<boolean>;
