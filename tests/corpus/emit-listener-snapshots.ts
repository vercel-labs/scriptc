// Listeners run from a snapshot of the list taken when the event is
// emitted: a listener added during an emit runs from the next emit on, a
// listener removed during an emit still runs in that emit, and a once
// listener runs once. Covers readline 'line' events and EventEmitter
// events with fewer and more listeners than a few.
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";

function emitter(count: number): void {
  const em = new EventEmitter();
  const log: string[] = [];
  const listeners: ((n: number) => void)[] = [];
  for (let i = 0; i < count; i++) {
    const listener = (n: number): void => {
      log.push(`${i}:${n}`);
      if (n === 1 && i === 0) em.on("tick", (m: number) => log.push(`late:${m}`));
      if (n === 1 && i === 1 && listeners[count - 1]) em.off("tick", listeners[count - 1]!);
    };
    listeners.push(listener);
    em.on("tick", listener);
  }
  em.once("tick", (n: number) => log.push(`once:${n}`));
  em.emit("tick", 1);
  em.emit("tick", 2);
  console.log(count, em.listenerCount("tick"), log.join(" "));
}

for (const count of [1, 2, 4, 5, 7]) emitter(count);

async function lines(count: number): Promise<void> {
  const input = Readable.from(["alpha\nbeta\n", "gamma\ndelta\n"]);
  const rl = createInterface({ input, terminal: false });
  const log: string[] = [];
  for (let i = 0; i < count; i++) {
    rl.on("line", (line: string) => {
      log.push(`${i}:${line}`);
      if (line === "beta" && i === 0) rl.on("line", (next: string) => log.push(`late:${next}`));
    });
  }
  rl.once("line", (line: string) => log.push(`once:${line}`));
  await new Promise<void>((resolve) => rl.on("close", () => resolve()));
  console.log(count, log.join(" "));
}

for (const count of [1, 3, 6]) await lines(count);
