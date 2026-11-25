// `yield*` in an async generator: the delegation protocol itself — next(v)
// forwarding into the delegate, throw(e) forwarding with a delegate that has
// a throw method and with one that does not (close, then TypeError),
// return(v) forwarding with a done delegate, a returning non-done delegate,
// a delegate with no return method (the awaited received value completes the
// generator), a synchronous delegate whose values and final value are
// awaited, a done step whose `value` accessor throws, and delegation over an
// array of promises (AsyncFromSyncIterator awaits each value).
function log(...parts) {
  console.log(parts.map((p) => String(p)).join(" "));
}

function asyncDelegate(steps) {
  let i = 0;
  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    next(v) {
      log("next", v);
      const step = steps[Math.min(i++, steps.length - 1)];
      return Promise.resolve(step);
    },
    throw(e) {
      log("throw", e);
      return Promise.resolve({ value: "from-throw:" + String(e), done: false });
    },
    return(v) {
      log("return", v);
      return Promise.resolve({ value: "from-return:" + String(v), done: true });
    },
  };
}

/**
 * `any` return channel: a delegate with no return method completes the
 * generator with the value the consumer passed to `return(v)`.
 * @param {any} d
 * @returns {AsyncGenerator<any, any, any>}
 */
async function* forwardNext(d) {
  const r = yield* d;
  log("after", r);
  return "body-return";
}

/**
 * @param {any} d
 * @returns {AsyncGenerator<any, string, any>}
 */
async function* forwardThrow(d) {
  try {
    yield* d;
  } catch (e) {
    log("caught", e.message);
    return "caught-return";
  }
  return "no-throw";
}

function closeableNoThrow() {
  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    next() {
      log("next", undefined);
      return Promise.resolve({ value: 1, done: false });
    },
    return() {
      log("close");
      return Promise.resolve({ value: undefined, done: true });
    },
  };
}

function noReturn() {
  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    next() {
      log("next", undefined);
      return Promise.resolve({ value: 1, done: false });
    },
  };
}

function returningNotDone() {
  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    next() {
      log("next", undefined);
      return Promise.resolve({ value: 1, done: false });
    },
    return(v) {
      log("return", v);
      return Promise.resolve({ value: "not-done:" + String(v), done: false });
    },
  };
}

function throwingValue() {
  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    next() {
      log("next", undefined);
      return {
        done: true,
        get value() {
          throw new Error("value-getter");
        },
      };
    },
  };
}

/**
 * @returns {Generator<Promise<number>, Promise<string>, any>}
 */
function* syncDelegate() {
  log("sync next");
  const received = yield Promise.resolve(1);
  log("sync received", received);
  yield Promise.resolve(2);
  return Promise.resolve("sync-return");
}

/**
 * @returns {AsyncGenerator<any, string, any>}
 */
async function* delegateSync() {
  const r = yield* syncDelegate();
  log("any after sync", r);
  return "sync-body-return";
}

/**
 * @returns {AsyncGenerator<any, void, any>}
 */
async function* notUnwrapped() {
  yield* asyncDelegate([
    { value: Promise.resolve("inner"), done: false },
    { value: "end", done: true },
  ]);
}

/**
 * @returns {AsyncGenerator<any, string, any>}
 */
async function* delegatePromises() {
  const r = yield* [Promise.resolve("first"), "second"];
  return "array done " + String(r);
}

async function drive(name, step) {
  try {
    log(name, JSON.stringify(await step()));
  } catch (e) {
    log(name, "REJECT", e.name, e.message);
  }
}

async function main() {
  const a = forwardNext(asyncDelegate([{ value: 1, done: false }, { value: 2, done: false }]));
  await drive("a.next1", () => a.next("x"));
  await drive("a.next2", () => a.next("y"));
  await drive("a.return", () => a.return("bye"));

  const b = forwardNext(asyncDelegate([{ value: 3, done: false }, { value: 4, done: true }]));
  await drive("b.next", () => b.next());
  await drive("b.next2", () => b.next());

  const c = forwardThrow(asyncDelegate([{ value: 5, done: false }, { value: 6, done: false }]));
  await drive("c.next", () => c.next());
  await drive("c.throw", () => c.throw("boom"));
  await drive("c.next-after", () => c.next());

  const d = forwardThrow(closeableNoThrow());
  await drive("d.next", () => d.next());
  await drive("d.throw", () => d.throw(new Error("nothrow")));

  const e = forwardNext(noReturn());
  await drive("e.next", () => e.next());
  await drive("e.return", () => e.return(Promise.resolve(42)));

  const f = forwardNext(returningNotDone());
  await drive("f.next", () => f.next());
  await drive("f.return1", () => f.return("first"));
  await drive("f.return2", () => f.return("second"));

  const g = forwardThrow(throwingValue());
  await drive("g.next", () => g.next());

  const h = delegateSync();
  await drive("h.next", () => h.next());
  await drive("h.next2", () => h.next());
  await drive("h.next3", () => h.next());

  const i = notUnwrapped();
  const inner = await i.next();
  log("i.next", inner.value instanceof Promise ? "promise" : "value:" + String(inner.value));
  await drive("i.next2", () => i.next());

  const j = delegatePromises();
  await drive("j.next", () => j.next());
  await drive("j.next2", () => j.next());
  await drive("j.next3", () => j.next());
}

main().then(
  () => log("passed"),
  (e) => {
    log("failed", e.message);
    process.exitCode = 1;
  },
);
