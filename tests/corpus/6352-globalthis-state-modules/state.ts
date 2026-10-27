// Shared by the boot and main modules: the state lives on the global
// object, keyed by registered symbols.
export const STATE_KEY = Symbol.for("example.boot-state");
export const PENDING_KEY = Symbol.for("example.boot-pending");

export interface BootState {
  startedAt: number;
  steps: string[];
}

export const globalState = globalThis as {
  [STATE_KEY]?: BootState;
  [PENDING_KEY]?: Promise<string>;
};

export function readState(): BootState | undefined {
  return globalState[STATE_KEY];
}
