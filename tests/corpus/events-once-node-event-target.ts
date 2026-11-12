// events.once over a NodeEventTarget (a MessagePort): Node's helper
// branches on the receiver, registering through the target's own once()
// rather than addEventListener. The promise resolves with the emitted
// argument — a NodeEventTarget's emit carries exactly one — the listener
// leaves, and a second once listener on 'error' rejects the promise with a
// value the target emits as 'error' while the wait runs; that listener
// leaves with the wait, whichever way it settled. Waiting on 'error'
// itself registers no second listener and resolves with the value instead.
// options.signal aborts the wait and leaves neither listener behind, and
// the registrations share the target's listener store with on()/once().
import { listenerCount, once } from "node:events";
import { MessageChannel } from "node:worker_threads";

async function outcome(p: Promise<unknown[]>): Promise<string> {
  try {
    const values = await p;
    return `ok ${values.length} ${values.map((value) => String(value)).join(",")}`;
  } catch (error) {
    const err = error as Error & { code?: string };
    return `err ${err.name} ${err.code} ${err.message}`;
  }
}

async function main(): Promise<void> {
  const { port1, port2 } = new MessageChannel();

  const message = once(port1, "msg");
  console.log("registered", listenerCount(port1, "msg"), port1.listenerCount("msg"));
  port1.emit("msg", "one", "ignored");
  console.log("resolved", await outcome(message));
  console.log("removed", listenerCount(port1, "msg"), port1.listenerCount("msg"));

  // A normal event leaves no 'error' listener behind.
  const work = once(port1, "work");
  console.log("waiting", port1.listenerCount("work"), port1.listenerCount("error"));
  port1.emit("work", "done");
  console.log("worked", await outcome(work));
  console.log("after work", port1.listenerCount("work"), port1.listenerCount("error"));

  // An 'error' emit while waiting rejects with the emitted value.
  const watching = once(port1, "never");
  port1.emit("error", new Error("boom"));
  console.log("error", await outcome(watching));
  console.log("after error", port1.listenerCount("never"), port1.listenerCount("error"));

  // Waiting on 'error' itself resolves with the value.
  const errorName = once(port1, "error");
  console.log("error registered", port1.listenerCount("error"));
  port1.emit("error", "as value");
  console.log("error as value", await outcome(errorName));
  console.log("error removed", port1.listenerCount("error"));

  // An abort removes both listeners and rejects with the AbortError.
  const controller = new AbortController();
  const aborted = once(port1, "pending", { signal: controller.signal });
  console.log("abort registered", port1.listenerCount("pending"), port1.listenerCount("error"));
  controller.abort("stop");
  try {
    await aborted;
    console.log("abort resolved");
  } catch (error) {
    const err = error as Error & { code?: string };
    console.log("aborted", err.name, err.code, err.cause);
  }
  console.log("abort removed", port1.listenerCount("pending"), port1.listenerCount("error"));

  // The wait's registrations share the store with the emitter spellings.
  const shared = (value: string): void => void console.log("shared", value);
  port1.on("shared", shared);
  const sharedWait = once(port1, "shared");
  console.log("shared registered", port1.listenerCount("shared"));
  port1.emit("shared", "both");
  console.log("shared resolved", await outcome(sharedWait));
  port1.off("shared", shared);
  console.log("shared removed", port1.listenerCount("shared"));

  port1.close();
  port2.close();
}

void main();
