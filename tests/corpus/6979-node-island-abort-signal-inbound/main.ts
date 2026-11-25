// @requires-libnode
// An AbortSignal a Node island made, used by native code. Native receivers
// test the signal they are given (fetch, AbortSignal.any, events.once,
// timers/promises, a listener's `signal` option, util.aborted): the
// island's signal is one to them, it aborts natively when the island aborts
// it, and it is the island's own object again when it goes back.
import { EventEmitter, once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { aborted } from "node:util";
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");

function show(error: unknown): string {
  const e = error as Error & { code?: string };
  return `${e.name} ${e.code} ${e.message}`;
}

const server = createServer((request, response) => {
  if (request.url === "/fast") response.end("fast body");
  // "/slow" is never answered.
});

// The program's transport: the native fetch, with the caller's signal.
async function transport(url: string, signal: AbortSignal): Promise<string> {
  const response = await fetch(url, { signal });
  return response.text();
}

// A native callback that compares the signal it is given twice, and keeps
// it to see the island abort it afterwards.
let kept: AbortSignal | undefined;

function twice(first: AbortSignal, second: AbortSignal): string {
  const keyed = new Map<AbortSignal, string>([[first, "first"]]);
  kept = first;
  return `${first === second} ${keyed.get(second) ?? "missing"} ${first.aborted}`;
}

async function main(port: number): Promise<void> {
  const base = `http://127.0.0.1:${port}`;

  // State, a native listener, and the island's own view.
  const first = lib.controller();
  const signal: AbortSignal = first.signal;
  console.log("before", signal.aborted, signal.reason, first.signal === signal, lib.same(first, signal));
  signal.addEventListener("abort", () => console.log("native listener", signal.aborted, signal.reason));
  console.log("island sees", lib.state(signal));
  first.abort("island reason");
  console.log("after", signal.aborted, signal.reason, lib.state(signal));
  try {
    signal.throwIfAborted();
  } catch (error) {
    console.log("throwIfAborted", error, error === signal.reason);
  }

  // Identity: one native signal per island signal, and the island's own back.
  const second = lib.controller();
  const map = new Map<unknown, string>([[second.signal, "second"]]);
  console.log("identity", map.get(second.signal), lib.keep(second.signal), lib.keep(second.signal));

  // The same island signal in two arguments of one native call: one native
  // signal, a Map keyed by either of them answers, and it is the one the
  // island aborts after the call.
  console.log("two arguments", lib.pair(twice));
  console.log("two arguments aborted", kept?.aborted, String(kept?.reason));
  // The same signal again in a later call, and another signal between two
  // mentions of one.
  let seen: AbortSignal | undefined;
  const sameTwice = (a: AbortSignal, b: AbortSignal): boolean => {
    const same = a === b && (seen === undefined || seen === a);
    seen = a;
    return same;
  };
  console.log("one signal in two arguments", lib.twice(sameTwice));
  const interleaved = (a: AbortSignal, b: AbortSignal, c: AbortSignal): string =>
    `${a === c} ${a === b} ${b.aborted} ${String(b.reason)}`;
  console.log("interleaved", lib.interleaved(interleaved));

  // Aborted before it arrived.
  const gone: AbortSignal = lib.aborted(new RangeError("gone"));
  console.log("arrives aborted", gone.aborted, show(gone.reason));

  // Native receivers.
  const third = lib.controller();
  const thirdSignal: AbortSignal = third.signal;
  const slept = sleep(60_000, "late", { signal: thirdSignal }).then(String, show);
  const waited = once(new EventEmitter(), "never", { signal: thirdSignal }).then(String, show);
  const resource = {};
  const told = aborted(thirdSignal, resource).then(() => "util.aborted resolved");
  const target = new EventTarget();
  target.addEventListener("ping", () => console.log("ping"), { signal: thirdSignal });
  target.dispatchEvent(new Event("ping"));
  const own = new AbortController();
  const either = AbortSignal.any([thirdSignal, own.signal]);
  either.addEventListener("abort", () => console.log("any aborted", either.reason));
  third.abort("third");
  target.dispatchEvent(new Event("ping"));
  console.log("sleep", await slept);
  console.log("once", await waited);
  console.log(await told);

  // An island timeout signal ends a native wait.
  const timed: AbortSignal = lib.timeout(20);
  console.log("timeout", await sleep(60_000, "late", { signal: timed }).then(String, (e: Error) => e.name));
  console.log("timeout reason", (timed.reason as Error).name);

  // The native fetch with the island's signal: completes, is cancelled by
  // the island in flight, and never starts for an aborted signal.
  console.log(await lib.request(transport, `${base}/fast`));
  console.log(await lib.request(transport, `${base}/slow`, 50));
  try {
    await fetch(`${base}/fast`, { signal: gone });
  } catch (error) {
    console.log("fetch with an aborted signal", show(error));
  }

  server.close();
  server.closeAllConnections();
}

server.listen(0, "127.0.0.1", () => {
  void main((server.address() as AddressInfo).port);
});
