import { value, choice, when } from "./dom.ts";

function attempt(probe: () => string): string {
  try {
    return probe();
  } catch (e) {
    return (e as Error).name;
  }
}

export function probes(): string {
  return [
    attempt(() => typeof (value as number)),
    attempt(() => typeof value!),
    attempt(() => typeof (value satisfies number)),
    attempt(() => (typeof choice !== "undefined" ? "defined" : "undefined")),
    attempt(() => (typeof choice === "boolean" ? "boolean" : "not boolean")),
    attempt(() => ("undefined" !== typeof (choice as string | number) ? "defined" : "undefined")),
    attempt(() => typeof choice),
    attempt(() => typeof when),
    attempt(() => (typeof when === "object" ? "object" : "other")),
  ].join(" ");
}
