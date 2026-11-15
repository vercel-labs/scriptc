// timers/promises setInterval(delay, value, options): ref and signal are
// setTimeout's options — ref: false leaves the loop's liveness alone, and an
// aborted signal ends the iteration with an AbortError whose cause is the
// signal's reason, both before the first tick and while waiting.
import { setInterval as every, scheduler } from "node:timers/promises";

function describe(e: unknown): string {
  const err = e as Error & { code?: string; cause?: unknown };
  return `${err.name} ${err.code} "${err.message}" cause=${String(err.cause)}`;
}

async function main(): Promise<void> {
  const keepAlive = setTimeout(() => {}, 1000);
  const loose = new AbortController();
  let n = 0;
  for await (const value of every(2, "tick", { ref: false, signal: loose.signal })) {
    console.log("tick", value, ++n);
    if (n === 2) break;
  }
  console.log("broke out");
  const ac = new AbortController();
  try {
    for await (const value of every(2, "x", { signal: ac.signal })) {
      console.log("tick", value);
      ac.abort(new Error("stop"));
    }
    console.log("loop ended");
  } catch (e) {
    console.log("aborted in loop", describe(e));
  }
  try {
    for await (const value of every(2, "y", { signal: AbortSignal.abort() })) {
      console.log("never", value);
    }
  } catch (e) {
    console.log("pre-aborted", describe(e));
  }
  await scheduler.wait(2, { ref: false, signal: new AbortController().signal });
  await scheduler.yield();
  clearTimeout(keepAlive);
  console.log("done");
}

void main();
