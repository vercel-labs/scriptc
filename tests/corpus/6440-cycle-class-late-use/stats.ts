import { logger, Sink } from "./log.ts";

export function prefix(): string {
  return "stats ";
}

export function report(): void {
  const sink = logger.make("report");
  sink.write(String(sink instanceof Sink));
}
