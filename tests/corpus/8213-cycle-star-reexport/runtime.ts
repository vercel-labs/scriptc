import { createServices, servicesLabel } from "./services.ts";

export class Runtime {
  readonly name: string;
  constructor(name: string) {
    this.name = name;
  }
  describe(): string {
    return `${this.name} runtime with ${servicesLabel}`;
  }
}

export const runtimeLabel = "runtime";

export function describeRuntime(): string {
  return `${runtimeLabel} (${typeof createServices})`;
}
