// The boot module writes the state through its own assertion of globalThis.
const STATE = Symbol.for("example.boot-state");
const PENDING = Symbol.for("example.boot-pending");

interface Early {
  startedAt: number;
  steps: string[];
}

export function boot(): void {
  const view = globalThis as { [STATE]?: Early; [PENDING]?: Promise<string> };
  view[STATE] = { startedAt: 42, steps: ["boot"] };
  view[PENDING] = Promise.resolve("container-1");
}
