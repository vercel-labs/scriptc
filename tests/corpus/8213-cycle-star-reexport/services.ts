import { Runtime, SDK_VERSION, describeRuntime, runtimeLabel } from "./sdk.ts";

export const servicesLabel = "services";

function probe(read: () => unknown): string {
  try {
    return String(read());
  } catch (error) {
    return `${(error as Error).name}: ${(error as Error).message}`;
  }
}

// This module runs first: sdk.ts and runtime.ts have not run yet.
const early = [
  probe(() => SDK_VERSION),
  probe(() => runtimeLabel),
  probe(() => typeof describeRuntime),
  probe(() => new Runtime("early").name),
];

export function servicesReport(): string {
  return `early ${early.join(" | ")}; late ${SDK_VERSION} ${runtimeLabel}`;
}

export function createServices(name: string): Runtime {
  return new Runtime(name);
}
