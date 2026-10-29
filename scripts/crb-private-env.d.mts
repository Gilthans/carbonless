export function privateDirs(dir: string): {
	XDG_STATE_HOME: string;
	XDG_CONFIG_HOME: string;
};
export function envrc(dir: string): string;
export function writePrivateConfig(dir: string, port: number): void;
export function removeStaleState(dir: string): void;
export function waitForLiveServer(
	port: number,
	timeoutMs: number,
): Promise<boolean>;
