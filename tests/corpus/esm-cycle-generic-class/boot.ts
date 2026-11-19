import { makeCustomEvent } from "./events.ts";

export function probeEarly(): string {
  try {
    return "constructed " + makeCustomEvent(1).type;
  } catch (error) {
    return `${(error as Error).name}: ${(error as Error).message}`;
  }
}

export function probeLate(): string {
  const a = makeCustomEvent("x");
  const b = makeCustomEvent<number>(7);
  return `${a.type}/${a.detail}/${b.detail}`;
}
