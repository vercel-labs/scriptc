// Class hierarchies across the CommonJS modules of an npm package (the
// undici dispatcher shape): an EventEmitter-rooted base in one module,
// symbol-keyed fields whose keys come from a shared export table, a
// computed accessor, subclasses in further modules re-exported through
// require bindings and inline requires, and TypeScript subclasses that
// override a JavaScript method with typed parameters and call super.
import { Agent, Dispatcher, DispatcherBase, Pool, describe, type Handler } from "dispatchkit";

class TracingAgent extends Agent {
  readonly trace: string[] = [];

  constructor() {
    super({ label: "tracing", prefix: "+" });
  }

  dispatch(path: string, handler: Handler): boolean {
    this.trace.push(path);
    return super.dispatch(path.toUpperCase(), handler);
  }
}

class LimitedPool extends Pool {
  rejected = 0;

  dispatch(path: string, handler: Handler): boolean {
    const ok = super.dispatch(path, handler);
    if (!ok) this.rejected++;
    return ok;
  }
}

const print: Handler = (line) => console.log("handled", line);

function run(d: Dispatcher, paths: string[]): void {
  for (const path of paths) console.log(path, "->", d.dispatch(path, print));
}

const plain = new Agent();
run(plain, ["/a", "/b"]);
console.log(describe(plain), plain.kind, plain.prefix);

const tracing = new TracingAgent();
tracing.on("closed", (label: unknown, count: unknown) => console.log("closed event", label, count));
run(tracing, ["/x", "/y/z"]);
console.log(tracing.trace.join(","), tracing.dispatched, tracing.closed);
tracing.close();
tracing.close();
console.log(describe(tracing), tracing.kind);
try {
  tracing.dispatch("/late", print);
} catch (err) {
  console.log("error", (err as Error).message);
}

const pool = new LimitedPool(3);
run(pool, ["/1", "/long", "/2"]);
console.log(pool.rejected, pool.size, pool.dispatched, pool instanceof DispatcherBase);
console.log(describe(pool), pool.kind);
