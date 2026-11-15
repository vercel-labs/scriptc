// events.once's options argument is any expression, as in Node's
// lib/events.js: the async function validates it with validateObject then
// validateAbortSignal on options.signal, reads no other property, and the
// call's own arguments are evaluated before that. A rejected validation
// rejects the promise rather than throwing out of the call, and the
// options value crosses to the receiver's own protocol unchanged.
import { EventEmitter, on, once } from "node:events";

async function outcome(promise: Promise<unknown[]>): Promise<string> {
  try {
    const values = await promise;
    return `ok ${JSON.stringify(values)}`;
  } catch (error) {
    const err = error as Error & { code?: string; cause?: unknown };
    const cause = err.cause === undefined ? "" : ` cause=${String(err.cause)}`;
    return `err ${err.name} ${err.code ?? "-"} ${err.message}${cause}`;
  }
}

async function main(): Promise<void> {
  const ee = new EventEmitter();
  const ac = new AbortController();

  // Built at run time with an unrelated property: only `signal` is read.
  const runtime = { signal: ac.signal, extra: 1, label: "opts" };
  const waiting = once(ee, "ready", runtime);
  ee.emit("ready", 1, "two");
  console.log("runtime options", await outcome(waiting));

  // The signal getter runs exactly once per once().
  let reads = 0;
  const counted: { signal?: AbortSignal } = {
    get signal(): AbortSignal | undefined {
      reads++;
      return undefined;
    },
  };
  const plain = once(ee, "counted", counted);
  console.log("signal reads", reads);
  ee.emit("counted", "value");
  console.log("counted", await outcome(plain), reads);

  // A frozen object, a class instance, and a null-prototype object are all
  // objects to validateObject.
  class Options {
    readonly signal?: AbortSignal;
    constructor(signal?: AbortSignal) {
      this.signal = signal;
    }
  }
  const frozen = once(ee, "frozen", Object.freeze({ signal: ac.signal }));
  ee.emit("frozen", "f");
  console.log("frozen", await outcome(frozen));
  const instance = once(ee, "instance", new Options());
  ee.emit("instance", "i");
  console.log("instance", await outcome(instance));
  const bare = Object.create(null) as { signal?: AbortSignal };
  const bareWait = once(ee, "bare", bare);
  ee.emit("bare", "b");
  console.log("null prototype", await outcome(bareWait));

  // An EventTarget takes the same options expression.
  const target = new EventTarget();
  const targetOptions = { signal: ac.signal, ignored: true };
  const targeted = once(target, "ping", targetOptions);
  target.dispatchEvent(new Event("ping"));
  console.log("target options", await outcome(targeted));

  // The arguments are evaluated at the call site, in order; validation runs
  // after that, inside the async function.
  const order: string[] = [];
  const ordered = once(ee, "ordered", (order.push("options"), { signal: undefined }));
  console.log("order after call", order.join(","));
  ee.emit("ordered", "o");
  console.log("ordered", await outcome(ordered), order.join(","));

  // validateObject(options, 'options'): null, an array, a function, and
  // primitives reject with Node's ERR_INVALID_ARG_TYPE.
  const notObject = [null, 5, "s", [], function options() {}];
  for (const value of notObject) {
    console.log(
      "bad options",
      await outcome(once(ee, "ready", value as unknown as { signal?: AbortSignal })),
    );
  }

  // events.on validates the same options object before its receiver, and
  // throws rather than returning a rejected promise.
  for (const value of notObject) {
    try {
      on(ee, "ready", value as unknown as { signal?: AbortSignal });
      console.log("on accepted options");
    } catch (error) {
      const err = error as Error & { code?: string };
      console.log("on bad options", err.name, err.code, err.message);
    }
  }

  // validateAbortSignal(options.signal, 'options.signal'), then the
  // pre-aborted AbortError; the options object itself is otherwise unused.
  for (const value of [null, 5, "s", {}, true]) {
    console.log(
      "bad signal",
      await outcome(once(ee, "ready", { signal: value } as unknown as { signal?: AbortSignal })),
    );
  }

  // A signal getter that throws rejects with that error.
  const throwing = {
    get signal(): AbortSignal {
      throw new Error("signal getter");
    },
  };
  console.log("throwing signal", await outcome(once(ee, "ready", throwing)));

  // A throwing getter for any other property never runs.
  let otherReads = 0;
  const noisy = {
    signal: undefined as AbortSignal | undefined,
    get other(): number {
      otherReads++;
      throw new Error("other getter");
    },
  };
  const noisyWait = once(ee, "noisy", noisy);
  ee.emit("noisy", "n");
  console.log("other getter reads", otherReads, await outcome(noisyWait));

  // The options are validated before the receiver.
  const notEmitter: any = 5;
  console.log("receiver last", await outcome(once(notEmitter, "x", null as any)));
  console.log("receiver error", await outcome(once(notEmitter, "x", { signal: ac.signal })));

  // A pre-aborted signal in a run-time options object.
  const early = new AbortController();
  const reason = new Error("early");
  early.abort(reason);
  const earlyTarget = new EventTarget();
  const earlyOptions = { signal: early.signal, ignored: 1 };
  try {
    await once(earlyTarget, "e", earlyOptions);
    console.log("pre-aborted resolved");
  } catch (error) {
    const err = error as Error & { code?: string };
    console.log("pre-aborted", err.name, err.code, err.cause === reason);
  }
}

void main();
