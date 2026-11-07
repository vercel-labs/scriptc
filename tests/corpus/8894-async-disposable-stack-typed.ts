// AsyncDisposableStack in typed code: use, adopt, defer, move and
// disposeAsync with class instances, sync-only resources and callbacks; LIFO
// disposal across awaits; SuppressedError chains; Node's interface errors;
// and the members read off the prototype. Node.js prints the same.
const log: string[] = [];
function flush(): void {
  console.log(log.join("\n"));
  log.length = 0;
}
class Resource {
  readonly name: string;
  constructor(name: string) {
    this.name = name;
  }
  async [Symbol.asyncDispose](): Promise<void> {
    log.push("enter " + this.name);
    await null;
    log.push("exit " + this.name);
  }
}
class SyncResource {
  readonly name: string;
  constructor(name: string) {
    this.name = name;
  }
  [Symbol.dispose](): void {
    log.push("sync " + this.name);
  }
}
// A synchronous [Symbol.dispose] is wrapped by the async hint: the promise it
// happens to return is never awaited, so disposal continues on schedule.
class PendingSync {
  [Symbol.dispose](): Promise<void> {
    log.push("pending sync");
    return new Promise<void>(() => {});
  }
}
class Failing {
  readonly name: string;
  constructor(name: string) {
    this.name = name;
  }
  async [Symbol.asyncDispose](): Promise<void> {
    throw new Error("fail " + this.name);
  }
}
async function attempt(label: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
    log.push(label + " ok");
  } catch (e) {
    if (e instanceof SuppressedError) {
      const chain: string[] = [];
      let cur: unknown = e;
      while (cur instanceof SuppressedError) {
        chain.push((cur.error as Error).message);
        cur = cur.suppressed;
      }
      chain.push(cur instanceof Error ? cur.message : String(cur));
      log.push(label + " SuppressedError " + e.message + " " + chain.join(" <- "));
    } else if (e instanceof Error) {
      log.push(label + " " + e.name + " " + e.message);
    } else {
      log.push(label + " thrown " + String(e));
    }
  }
}
async function main(): Promise<void> {
  // `await using` over the stack itself disposes it at scope exit, waiting
  // for disposeAsync (a class instance's static [Symbol.asyncDispose] path).
  {
    await using scope = new AsyncDisposableStack();
    scope.use(new Resource("scoped"));
    scope.defer(async () => {
      log.push("scoped defer");
    });
    log.push("inside scope " + String(scope.disposed));
  }
  log.push("after scope");
  flush();

  const stack = new AsyncDisposableStack();
  const first = stack.use(new Resource("a"));
  log.push("got " + first.name);
  stack.use(new SyncResource("s"));
  stack.defer(async () => {
    log.push("defer");
  });
  const adopted = stack.adopt(42, async (value: unknown) => {
    log.push("adopt " + String(value));
  });
  log.push("adopted " + String(adopted) + " disposed " + String(stack.disposed));
  stack.use(null);
  stack.use(undefined);
  const answer: unknown = await stack.disposeAsync();
  log.push("answer " + String(answer) + " disposed " + String(stack.disposed));
  flush();

  const pending = new AsyncDisposableStack();
  pending.use(new PendingSync());
  pending.defer(async () => {
    log.push("after pending");
  });
  const pendingAnswer: unknown = await pending.disposeAsync();
  log.push("pending answer " + String(pendingAnswer));
  flush();

  const moved = new AsyncDisposableStack();
  moved.defer(async () => {
    log.push("ran on moved");
  });
  const target = moved.move();
  log.push("move " + String(moved.disposed) + " " + String(target.disposed) + " " +
    String(target instanceof AsyncDisposableStack));
  await target.disposeAsync();
  flush();

  await attempt("three failures", async () => {
    const failing = new AsyncDisposableStack();
    failing.use(new Failing("one"));
    failing.defer(async () => {
      throw new Error("two");
    });
    failing.use(new Failing("three"));
    await failing.disposeAsync();
  });
  await attempt("single", async () => {
    const single = new AsyncDisposableStack();
    single.use(new Resource("before"));
    single.defer(async () => {
      throw new RangeError("only");
    });
    await single.disposeAsync();
  });
  await attempt("thrown value", async () => {
    const thrown = new AsyncDisposableStack();
    thrown.defer(async () => {
      throw 7;
    });
    await thrown.disposeAsync();
  });
  await attempt("sync throw", async () => {
    const thrown = new AsyncDisposableStack();
    thrown.use({
      [Symbol.asyncDispose]() {
        throw new Error("sync body");
      },
    });
    await thrown.disposeAsync();
  });
  const done = new AsyncDisposableStack();
  await done.disposeAsync();
  await attempt("use after dispose", async () => {
    done.use(new Resource("late"));
  });
  await attempt("move after dispose", async () => {
    done.move();
  });
  await attempt("dispose twice", async () => {
    await done.disposeAsync();
  });
  await attempt("use non-object", async () => {
    new AsyncDisposableStack().use(5 as unknown as AsyncDisposable);
  });
  await attempt("defer non-function", async () => {
    new AsyncDisposableStack().defer(3 as unknown as () => void);
  });
  const shown = new AsyncDisposableStack();
  console.log(shown, String(shown), Object.prototype.toString.call(shown), JSON.stringify(shown));
  const detached = new AsyncDisposableStack();
  const { use, disposeAsync } = detached;
  await attempt("detached use", async () => {
    use.call({}, null);
  });
  await attempt("detached disposeAsync", async () => {
    await disposeAsync.call(5);
  });
  const reentrant = new AsyncDisposableStack();
  reentrant.defer(async () => {
    log.push("inside " + String(reentrant.disposed));
  });
  await reentrant.disposeAsync();
  const self = new AsyncDisposableStack();
  self.defer(async () => {
    log.push("self " + String(self.disposed));
  });
  await self[Symbol.asyncDispose]();
  for (let i = 0; i < 3; i++) {
    const cyc = new AsyncDisposableStack();
    cyc.defer(async () => {
      log.push("never " + String(cyc.disposed));
    });
  }
  const holder = { stack: new AsyncDisposableStack() };
  console.log(holder, [holder.stack]);
  flush();
}
main();
