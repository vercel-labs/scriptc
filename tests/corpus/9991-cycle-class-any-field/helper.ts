import Hub from "./hub.ts";

export function label(hub: Hub): string {
  return `${hub.name}/${typeof hub.meta}`;
}
export function spare(): Hub {
  return new Hub("spare");
}

// This module is evaluated before the class's module.
let early = "not tried";
try {
  early = spare().name;
} catch (err) {
  early = `${(err as Error).name}: ${(err as Error).message}`;
}
export const earlyResult = early;
