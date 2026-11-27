export const OWNER_ENV: "CRB_OWNER";
export function ownerToken(pid: number): string;
export function watchOwner(onGone: () => void, token?: string): void;
