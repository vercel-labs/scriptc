// The receivers of 6970-6972 (node-island-abort-signal*), compiled natively:
// the same checks on an AbortSignal that never leaves native code, so the
// native tier and a Node island answer alike for brand tests, listener
// forms, reasons, AbortSignal.timeout and any, events.once and
// timers/promises.
import { EventEmitter, addAbortListener, getEventListeners, once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";

interface RequestOptions {
  signal?: AbortSignal;
  retries: number;
}

function show(reason: unknown): string {
  if (reason instanceof Error) return `${reason.name}: ${reason.message}`;
  if (typeof reason === "object" && reason !== null) return JSON.stringify(reason);
  return `${typeof reason} ${String(reason)}`;
}

function describe(signal: AbortSignal): string {
  return [
    Object.prototype.toString.call(signal),
    signal instanceof EventTarget,
    signal.aborted,
  ].join(" ");
}

function state(signal: AbortSignal): string {
  return `${signal.aborted} ${show(signal.reason)}`;
}

function watch(label: string, signal: AbortSignal): void {
  signal.addEventListener("abort", (event) => {
    console.log(label, "abort", event.type, event.target === signal, event.isTrusted, state(signal));
  });
}

function throwIfAborted(signal: AbortSignal): string {
  try {
    signal.throwIfAborted();
    return "did not throw";
  } catch (error) {
    return `threw ${show(error)} same ${error === signal.reason}`;
  }
}

function request(options: RequestOptions): Promise<string> {
  const copy: RequestOptions = { ...options };
  const signal = copy.signal;
  return new Promise((resolve, reject) => {
    if (signal === undefined) return resolve(`no signal ${copy.retries}`);
    signal.throwIfAborted();
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

function listeners(signal: AbortSignal): () => string {
  const log: string[] = [];
  const removed = (): void => {
    log.push("removed");
  };
  signal.addEventListener("abort", () => log.push("first"));
  signal.addEventListener("abort", removed);
  signal.addEventListener("abort", () => log.push("once"), { once: true });
  signal.onabort = () => log.push("onabort");
  signal.removeEventListener("abort", removed);
  const other = new AbortController();
  signal.addEventListener("abort", () => log.push("cancelled"), { signal: other.signal });
  other.abort();
  signal.addEventListener("abort", () => log.push(`last ${getEventListeners(signal, "abort").length}`));
  return () => log.join(",");
}

function whenAborted(label: string, signal: AbortSignal): Promise<string> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(`${label} already ${show(signal.reason)}`);
    signal.addEventListener("abort", () => resolve(`${label} aborted ${show(signal.reason)}`), {
      once: true,
    });
  });
}

async function outcome(promise: Promise<unknown>, signal: AbortSignal): Promise<string> {
  try {
    return `resolved ${String(await promise)}`;
  } catch (error) {
    const e = error as Error & { code?: string; cause?: unknown };
    return `${e.name} ${e.code} cause ${show(e.cause)} same ${e.cause === signal.reason}`;
  }
}

async function main(): Promise<void> {
  const alive = setInterval(() => {}, 1000);

  const first = new AbortController();
  console.log("brand", describe(first.signal));
  watch("first", first.signal);
  console.log("before", state(first.signal));
  console.log("not aborted", throwIfAborted(first.signal));
  first.abort("stop");
  console.log("after", state(first.signal));
  console.log("aborted", throwIfAborted(first.signal));
  first.abort("again");
  console.log("again", state(first.signal));

  const second = new AbortController();
  const pending = request({ signal: second.signal, retries: 2 });
  second.abort(new RangeError("cancelled"));
  try {
    console.log(await pending);
  } catch (error) {
    console.log("request rejected", error instanceof RangeError, (error as Error).message);
  }
  console.log(await request({ retries: 3 }));

  const third = new AbortController();
  watch("third", third.signal);
  third.abort();
  const fourth = new AbortController();
  watch("fourth", fourth.signal);
  fourth.abort(42);
  const fifth = new AbortController();
  watch("fifth", fifth.signal);
  fifth.abort(null);

  const seventh = new AbortController();
  const report = listeners(seventh.signal);
  seventh.abort("forms");
  console.log("forms", report());

  const eighth = new AbortController();
  const disposable = addAbortListener(eighth.signal, () => console.log("addAbortListener ran"));
  const waited = outcome(once(new EventEmitter(), "never", { signal: eighth.signal }), eighth.signal);
  const slept = outcome(sleep(60_000, "late", { signal: eighth.signal }), eighth.signal);
  const any = AbortSignal.any([eighth.signal, new AbortController().signal]);
  console.log("any before", any.aborted, "disposable", typeof disposable[Symbol.dispose]);
  eighth.abort(new Error("enough"));
  console.log("any after", any.aborted, String(any.reason));
  console.log("once", await waited);
  console.log("sleep", await slept);

  // Already aborted.
  console.log(state(AbortSignal.abort()), "|", state(AbortSignal.abort("text")), "|", state(AbortSignal.abort(0)));
  console.log("aborted any", await whenAborted("any", AbortSignal.any([AbortSignal.abort("was")])));

  // Timeout and any.
  const timeout = AbortSignal.timeout(20);
  console.log(await whenAborted("timeout", timeout), timeout.aborted);
  const a = new AbortController();
  const b = new AbortController();
  const either = AbortSignal.any([a.signal, b.signal]);
  const eitherDone = whenAborted("any", either);
  b.abort(new Error("b first"));
  console.log(await eitherDone, either.aborted, a.signal.aborted);
  clearInterval(alive);
}

main();
