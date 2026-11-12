// events.once over an EventTarget (Node's generic path in lib/events.js):
// the promise resolves with the dispatched event as the array's one
// element, a plain target registers no 'error' listener and so waits on
// that name like any other, and the awaited listener resists
// stopImmediatePropagation. options.signal is validated before the
// receiver — undefined is the plain form, a value that is not an
// AbortSignal rejects with ERR_INVALID_ARG_TYPE, and an aborted signal
// rejects with an AbortError whose cause is its reason, removing both
// listeners. A receiver that is neither an EventTarget nor an
// EventEmitter rejects with ERR_INVALID_ARG_TYPE naming the emitter
// argument. The result adopts the executor's promise, so it settles a
// turn after the event, and an EventTarget subclass and a
// checked-dynamic receiver take the same path.
import { listenerCount, once } from "node:events";

async function outcome(p: Promise<unknown[]>): Promise<string> {
  try {
    const values = await p;
    const shown = values.map((value) =>
      value instanceof Event ? `Event:${value.type}` : String(value),
    );
    return `ok ${values.length} ${shown.join(",")}`;
  } catch (error) {
    const err = error as Error & { code?: string };
    return `err ${err.name} ${err.code} ${err.message}`;
  }
}

class Ticker extends EventTarget {}

async function main(): Promise<void> {
  const target = new EventTarget();
  const ping = once(target, "ping");
  console.log("target registered", listenerCount(target, "ping"), ping instanceof Promise);
  target.dispatchEvent(new Event("ping"));
  console.log("target resolved", await outcome(ping));
  console.log("target removed", listenerCount(target, "ping"));
  target.dispatchEvent(new Event("ping"));

  // An AbortSignal is itself an EventTarget.
  const controller = new AbortController();
  const aborted = once(controller.signal, "abort");
  console.log("signal registered", listenerCount(controller.signal, "abort"));
  controller.abort();
  console.log("signal resolved", await outcome(aborted));
  console.log("signal removed", listenerCount(controller.signal, "abort"));

  // A compiled subclass and a checked-dynamic receiver take the same path.
  const ticker = new Ticker();
  const tick = once(ticker, "tick");
  ticker.dispatchEvent(new Event("tick"));
  console.log("subclass resolved", await outcome(tick));
  const dynamic: any = new EventTarget();
  const go = once(dynamic, "go");
  dynamic.dispatchEvent(new Event("go"));
  console.log("dynamic resolved", await outcome(go));

  // 'error' has no special meaning for a target.
  const errors = new EventTarget();
  const errorName = once(errors, "error");
  errors.dispatchEvent(new Event("error"));
  console.log("error name", await outcome(errorName));

  // The awaited listener fires even after a sibling stops the dispatch.
  const resisting = new EventTarget();
  resisting.addEventListener("s", (event) => event.stopImmediatePropagation());
  const resisted = once(resisting, "s");
  resisting.dispatchEvent(new Event("s"));
  console.log("resist", await outcome(resisted));

  // An undefined signal is the plain form; null is the wrong type.
  const loose = new EventTarget();
  const looseWait = once(loose, "u", { signal: undefined });
  loose.dispatchEvent(new Event("u"));
  console.log("undefined signal", await outcome(looseWait));
  console.log("null signal", await outcome(once(new EventTarget(), "x", { signal: null as any })));
  console.log(
    "bad signal",
    await outcome(once(new EventTarget(), "x", { signal: 1 as any })),
  );

  // An aborted signal rejects before anything is registered, and an abort
  // during the wait removes both listeners.
  const early = new AbortController();
  const reason = new Error("stop early");
  early.abort(reason);
  const earlyTarget = new EventTarget();
  try {
    await once(earlyTarget, "x", { signal: early.signal });
    console.log("pre-aborted resolved");
  } catch (error) {
    const err = error as Error & { code?: string };
    console.log("pre-aborted", err.name, err.code, err.cause === reason, listenerCount(earlyTarget, "x"));
  }
  const late = new AbortController();
  const lateTarget = new EventTarget();
  const lateWait = once(lateTarget, "x", { signal: late.signal });
  console.log("mid registered", listenerCount(lateTarget, "x"), listenerCount(late.signal, "abort"));
  late.abort("why");
  try {
    await lateWait;
    console.log("mid-abort resolved");
  } catch (error) {
    const err = error as Error & { code?: string };
    console.log("mid-abort", err.name, err.code, err.cause);
  }
  console.log("mid removed", listenerCount(lateTarget, "x"), listenerCount(late.signal, "abort"));

  // The event settling first removes the abort listener.
  const clean = new AbortController();
  const cleanTarget = new EventTarget();
  const cleanWait = once(cleanTarget, "y", { signal: clean.signal });
  cleanTarget.dispatchEvent(new Event("y"));
  console.log("clean resolved", await outcome(cleanWait), listenerCount(clean.signal, "abort"));
  clean.abort();

  // Neither an EventTarget nor an EventEmitter.
  const notEmitter: any = 5;
  console.log("bad receiver", await outcome(once(notEmitter, "x")));

  // The result settles a turn after the event, like an async function's.
  const ordered = new EventTarget();
  const order: string[] = [];
  const orderedWait = once(ordered, "z");
  orderedWait.then(() => order.push("then"));
  ordered.dispatchEvent(new Event("z"));
  order.push("sync");
  await Promise.resolve();
  order.push("micro1");
  await Promise.resolve();
  order.push("micro2");
  await Promise.resolve();
  order.push("micro3");
  await orderedWait;
  console.log("order", order.join(","));
}

void main();
