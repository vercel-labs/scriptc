// events.once over names the program does not fix to a typed event tuple: a
// computed string, a symbol, and the same computed value at both the wait
// and the emit. The listeners register as checked-dynamic function values,
// so the promise carries the emit's arguments as given whatever their
// shapes, an 'error' emit rejects it with the emitted value, and the options
// ladder (an invalid options object, an invalid signal, an abort) runs on
// that path too. A throwing 'newListener' listener rejects the wait without
// adding the listener it announced. Every settlement leaves neither
// listener behind.
import { EventEmitter, once } from "node:events";

async function outcome(p: Promise<unknown[]>): Promise<string> {
  try {
    const values = await p;
    return `ok ${values.length} ${values.map((value) => JSON.stringify(value)).join(",")}`;
  } catch (error) {
    const err = error as Error & { code?: string };
    return `err ${err.name} ${err.code} ${err.message}`;
  }
}

async function main(): Promise<void> {
  const em = new EventEmitter();
  em.setMaxListeners(0);
  const name = process.argv[2] ?? "dyn";

  // A computed name: the wait and the emit agree on the value, the arguments
  // keep their shapes, and the 'error' listener leaves with the wait.
  const computed = once(em, name);
  console.log("computed waits", em.listenerCount(name), em.listenerCount("error"));
  em.emit(name, 1, "two", { three: 3 }, [4]);
  console.log("computed", await outcome(computed));
  console.log("computed left", em.listenerCount(name), em.listenerCount("error"));

  // A symbol name keeps its identity: the emit names the same symbol.
  const sym = Symbol("evt");
  const symbolWait = once(em, sym);
  em.emit(sym, "a", 2);
  console.log("symbol", await outcome(symbolWait));

  // An 'error' emit while the computed name is awaited rejects the wait.
  const failing = once(em, name);
  em.emit("error", new Error("boom"));
  console.log("error", await outcome(failing));
  console.log("error left", em.listenerCount(name), em.listenerCount("error"));

  // The options ladder on the computed path: a bad signal, then a bad
  // options object, both rejecting before a listener is registered.
  console.log("bad signal", await outcome(once(em, name, { signal: 5 as any })));
  console.log("bad options", await outcome(once(em, name, 5 as any)));
  console.log("nothing registered", em.listenerCount(name), em.listenerCount("error"));

  // An abort rejects with the AbortError and leaves no listener behind.
  const controller = new AbortController();
  const aborted = once(em, name, { signal: controller.signal });
  controller.abort();
  console.log("abort", await outcome(aborted));
  console.log("abort left", em.listenerCount(name), em.listenerCount("error"));

  // A signal that does not abort changes nothing: the event still settles
  // the wait and removes the abort listener.
  const quiet = new AbortController();
  const settled = once(em, name, { signal: quiet.signal });
  em.emit(name, "quiet");
  console.log("signal", await outcome(settled));

  // A throwing 'newListener' listener rejects the wait and leaves nothing
  // behind: the listener its announcement preceded is never added.
  const guarded = new EventEmitter();
  guarded.setMaxListeners(0);
  guarded.on("newListener", (announced: string) => {
    if (announced === name) throw new Error("announcement");
  });
  console.log("guarded", await outcome(once(guarded, name)));
  console.log("guarded left", guarded.listenerCount(name), guarded.listenerCount("error"));
}

void main();
