// A function binding declared without a value and handed to a library
// callback parameter. The binding's storage holds undefined until its first
// store, and the library takes the function its declaration names: a
// required callback reads the stored function and throws the library's own
// TypeError for an unassigned binding, an optional one keeps undefined.
import { EventEmitter } from "node:events";
import * as http from "node:http";
import * as net from "node:net";

interface Bound {
  server: http.Server;
  outcome: Promise<string>;
  closed: Promise<string>;
}

// Assigned by one promise executor, registered from a callback of another.
function bind(): Promise<Bound> {
  let settle: (text: string) => void;
  let fail: (error: Error) => void;
  let shut: () => void;
  const outcome = new Promise<string>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  const closed = new Promise<string>((resolve) => {
    shut = () => resolve("close listener ran");
  });
  const server = http.createServer((request, response) => {
    response.end("ok");
    settle("served " + String(request.url));
  });
  return new Promise<Bound>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      server.on("error", fail);
      server.on("close", shut);
      resolve({ server, outcome, closed });
    });
  });
}

// `let x!: T` read in the declaring function's own code.
function assertedBinding(): Promise<string> {
  let fail!: (error: Error) => void;
  let done!: (text: string) => void;
  const result = new Promise<string>((resolve, reject) => {
    fail = reject;
    done = resolve;
  });
  const server = net.createServer();
  server.on("error", fail);
  server.on("close", () => done("asserted binding closed"));
  server.listen(0, "127.0.0.1", () => {
    server.close();
  });
  return result;
}

// Registered and removed by the same function value, and array callbacks.
function emitterListeners(): Promise<string> {
  let done: (text: string) => void;
  let never: (text: string) => void;
  let visit: (value: number) => void;
  const seen: number[] = [];
  const result = new Promise<string>((resolve) => {
    done = resolve;
    never = () => console.log("a removed listener ran");
    visit = (value) => {
      seen.push(value * 2);
    };
  });
  const emitter = new EventEmitter();
  const arm = (): void => {
    emitter.on("word", never);
    emitter.off("word", never);
    emitter.once("word", done);
    [1, 2, 3].forEach(visit);
  };
  arm();
  console.log("listeners", emitter.listenerCount("word"), "visited", seen.join(","));
  emitter.emit("word", "emitter heard once");
  console.log("listeners", emitter.listenerCount("word"));
  return result;
}

// Timers and the microtask queue.
function scheduled(): Promise<string> {
  let tick: () => void;
  let fire: () => void;
  const order: string[] = [];
  const result = new Promise<string>((resolve) => {
    tick = () => {
      order.push("tick");
    };
    fire = () => {
      order.push("timer");
      resolve(order.join(" then "));
    };
  });
  const arm = (): void => {
    setTimeout(fire, 1);
    process.nextTick(tick);
  };
  arm();
  return result;
}

// A binding a closure reassigns: each registration reads the current value.
function reassigned(): void {
  let handler: (n: number) => void;
  const install = (next: (n: number) => void): void => {
    handler = next;
  };
  const emitter = new EventEmitter();
  const attach = (): void => {
    emitter.on("n", handler);
  };
  install((n) => console.log("first handler", n));
  attach();
  install((n) => console.log("second handler", n));
  attach();
  emitter.emit("n", 7);
  const each = (): void => {
    [1, 2].forEach(handler);
  };
  each();
}

// A module-level binding stored by one function and read by another.
let tally: (value: number) => void;
let total = 0;
function installTally(): void {
  tally = (value) => {
    total += value;
  };
}
function runTally(): void {
  [1, 2, 3].forEach(tally);
  const emitter = new EventEmitter();
  emitter.on("n", tally);
  emitter.emit("n", 10);
}

// A function-typed field declared without an initializer.
class Hub {
  report!: (text: string) => void;
  unset!: (text: string) => void;
  attach(emitter: EventEmitter): void {
    emitter.on("word", this.report);
  }
  attachUnset(emitter: EventEmitter): void {
    emitter.on("word", this.unset);
  }
}

function attempt(label: string, run: () => void): void {
  try {
    run();
    console.log(label, "did not throw");
  } catch (error) {
    const e = error as Error & { code?: string };
    console.log(label, e instanceof TypeError, e.name, String(e.code), e.message);
  }
}

// A required callback handed an unassigned binding throws what the library
// throws for undefined.
function unassignedRequired(): void {
  let listener!: (text: string) => void;
  let fail!: (error: Error) => void;
  let visit!: (n: number) => void;
  let keep!: (n: number) => boolean;
  let fire!: () => void;
  const emitter = new EventEmitter();
  const server = http.createServer();
  attempt("emitter.on", () => emitter.on("word", listener));
  attempt("emitter.once", () => emitter.once("word", listener));
  attempt("server.on", () => server.on("error", fail));
  attempt("forEach", () => [1].forEach(visit));
  attempt("filter", () => [1].filter(keep));
  attempt("setTimeout", () => setTimeout(fire, 1));
  attempt("nextTick", () => process.nextTick(fire));
  console.log("listeners after the failed registrations", emitter.listenerCount("word"));
}

// An optional callback handed an unassigned binding is an absent callback.
function unassignedOptional(): Promise<void> {
  let replace!: (key: string, value: unknown) => unknown;
  let map!: (text: string) => string;
  let recover!: (error: unknown) => string;
  let last!: () => void;
  const run = (): Promise<void> => {
    console.log(JSON.stringify({ a: 1 }, replace));
    return Promise.resolve("handlers passed through")
      .then(map)
      .catch(recover)
      .finally(last)
      .then((text) => console.log(text));
  };
  return run();
}

function trace<T>(label: string, value: T): T {
  console.log("evaluated", label);
  return value;
}

function refuse(): number {
  throw new RangeError("a later argument threw");
}

// The library looks at the callback once the receiver and every argument
// are evaluated: their effects come first, and an exception one of them
// throws wins.
function evaluationOrder(): Promise<void> {
  let fire!: () => void;
  let take!: (n: number) => void;
  let visit!: (n: number) => void;
  let listener!: (text: string) => void;
  const emitter = new EventEmitter();
  attempt("timer delay", () => setTimeout(fire, trace("delay", 1)));
  attempt("timer arguments", () => setTimeout(take, trace("delay", 1), trace("argument", 2)));
  attempt("timer delay throws", () => setTimeout(fire, refuse()));
  attempt("nextTick argument", () => process.nextTick(take, trace("argument", 3)));
  attempt("nextTick argument throws", () => process.nextTick(take, refuse()));
  attempt("forEach thisArg", () => [1, 2].forEach(visit, trace("thisArg", { tag: 1 })));
  attempt("forEach thisArg throws", () => [1, 2].forEach(visit, refuse()));
  attempt("emitter receiver", () => trace("receiver", emitter).on("word", listener));
  attempt("emitter name", () => emitter.on(trace("name", "word"), listener));

  // The same calls with the bindings assigned.
  let took: (n: number) => void;
  let saw: (n: number) => void;
  let done: () => void;
  const finished = new Promise<void>((resolve) => {
    done = resolve;
    took = (n) => console.log("took", n);
    saw = (n) => console.log("saw", n);
  });
  const run = (): void => {
    setTimeout(took, trace("delay", 1), trace("argument", 2));
    process.nextTick(took, trace("argument", 3));
    [1, 2].forEach(saw, trace("thisArg", { tag: 1 }));
    setTimeout(done, 5);
  };
  run();
  return finished;
}

// The receiver and each argument are read where they are written: an
// argument that assigns one of their bindings does not change the call.
function operandsHeld(): Promise<void> {
  let visit!: (n: number) => void;
  let unset!: (text: string) => void;
  let saw: (n: number) => void;
  let heard: (text: string) => void;
  let took: (n: number) => void;
  let done: () => void;
  const finished = new Promise<void>((resolve) => {
    done = resolve;
    saw = (n) => console.log("held list item", n);
    heard = (text) => console.log("held emitter heard", text);
    took = (n) => console.log("held argument", n);
  });
  const self = { tag: 1 };
  const other = [7, 8, 9];
  let list = [1, 2];
  const swap = (): { tag: number } => {
    list = other;
    return self;
  };
  attempt("forEach receiver reassigned", () => list.forEach(visit, swap()));
  console.log("list is now", list.join(","));
  list = [1, 2];
  const first = new EventEmitter();
  const second = new EventEmitter();
  let emitter = first;
  attempt("emitter receiver reassigned", () => emitter.on(((emitter = second), "word"), unset));
  console.log("emitter is now the second", emitter === second);
  emitter = first;
  let extra = 5;
  const run = (): void => {
    list.forEach(saw, swap());
    list = [1, 2];
    list.forEach(saw, ((list = other), self));
    emitter.on(((emitter = second), "word"), heard);
    setTimeout(took, 1, extra, trace("later argument", (extra = 9)));
    process.nextTick(took, extra, trace("later argument", (extra = 11)));
    setTimeout(done, 20);
  };
  run();
  console.log("listeners", first.listenerCount("word"), second.listenerCount("word"));
  first.emit("word", "on the first emitter");
  return finished;
}

async function main(): Promise<void> {
  const bound = await bind();
  const address = bound.server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  http.get({ host: "127.0.0.1", port, path: "/first" }, (response) => {
    response.resume();
  });
  console.log(await bound.outcome);
  bound.server.close();
  console.log(await bound.closed);
  console.log(await assertedBinding());
  console.log(await emitterListeners());
  console.log(await scheduled());
  reassigned();
  installTally();
  runTally();
  console.log("tally", total);

  const hub = new Hub();
  const emitter = new EventEmitter();
  try {
    hub.attachUnset(emitter);
    console.log("an unset field registered");
  } catch (error) {
    console.log("unset field", error instanceof TypeError);
  }
  hub.report = (text) => console.log("field listener heard", text);
  hub.attach(emitter);
  emitter.emit("word", "once");

  unassignedRequired();
  await unassignedOptional();
  await evaluationOrder();
  await operandsHeld();
}

void main();
