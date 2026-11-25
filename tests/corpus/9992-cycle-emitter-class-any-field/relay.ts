import { Station } from "./station.ts";

export function summarize(station: Station): string {
  return `${station.name}:${JSON.stringify(station.extra)}:${station.log.length}:${station.listenerCount("signal")}`;
}
export function open(name: string): Station {
  return new Station(name);
}

// Evaluated before the class's module: the first call reaches the class early.
let tried = "not tried";
try {
  tried = summarize(open("early"));
} catch (err) {
  tried = `${(err as Error).name}: ${(err as Error).message}`;
}
export const firstTry = tried;
