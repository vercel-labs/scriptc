import { createServices } from "./services.ts";

export * from "./runtime.ts";

export const SDK_VERSION = "1.4.0";

export function createSession(name: string) {
  return createServices(name);
}
