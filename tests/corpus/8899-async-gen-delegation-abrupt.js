// `yield*` in an async generator: the abrupt and malformed delegate shapes
// around the delegation protocol — an iterator that is not an object, a
// non-callable next/return/throw method, a step result that is not an object
// after the Await, throwing `done` and `value` accessors, and the synchronous
// delegate reached through AsyncFromSyncIterator.
function log(...parts) {
  console.log(parts.map((p) => String(p)).join(" "));
}

/**
 * A thrown value's name and message, except that the protocol's TypeErrors
 * are pinned by their shape: Node names the offending value ("number 7 is
 * not a function", "Result of the Symbol.asyncIterator method is not an
 * object") where scriptc names the protocol read ("iterator method is not a
 * function", "Iterator result 42 is not an object") — the wording every
 * for-of and delegation path already throws, so the throw and where it
 * happens are what this pins.
 * @param {any} e
 * @returns {string}
 */
function describe(e) {
  const name = (e && e.name) || "";
  const message = (e && e.message) || "";
  if (/is not a function$/.test(message)) return name + " not-a-function";
  if (/is not an object$/.test(message)) return name + " not-an-object";
  return name + " " + message;
}

/**
 * @param {any} d
 * @returns {AsyncGenerator<any, string, any>}
 */
async function* forward(d) {
  try {
    const r = yield* d;
    log("returned", JSON.stringify(r));
    return "delegate-return";
  } catch (e) {
    log("caught", describe(e));
    return "caught-return";
  }
}

async function step(name, gen) {
  try {
    log(name, JSON.stringify(await gen.next()));
  } catch (e) {
    log(name, "REJECT", e.name, e.message);
  }
}

function asyncIterable(methods) {
  return {
    [Symbol.asyncIterator]() {
      return methods;
    },
  };
}

function syncIterable(methods) {
  return {
    get [Symbol.asyncIterator]() {
      return undefined;
    },
    [Symbol.iterator]() {
      return methods;
    },
  };
}

var reason = {};

async function main() {
  // The @@asyncIterator method's result is not an object.
  const notObjectIterator = { [Symbol.asyncIterator]() { return 42; } };
  const a = forward(notObjectIterator);
  await step("a", a);

  // A non-callable next method.
  const notCallableNext = asyncIterable({ next: 42 });
  const b = forward(notCallableNext);
  await step("b", b);

  // next() answers a non-object, which Await passes through unchanged.
  const nonObjectStep = asyncIterable({
    next() {
      log("non-object next call");
      return 42;
    },
  });
  const c = forward(nonObjectStep);
  await step("c", c);

  // A `done` accessor that throws while a value is still available.
  const abruptDone = asyncIterable({
    next() {
      log("abrupt-done next call");
      return {
        get done() {
          throw reason;
        },
        value: 1,
      };
    },
  });
  const d = forward(abruptDone);
  await step("d", d);

  // A `value` accessor that throws on the completing step.
  const abruptValue = asyncIterable({
    next() {
      log("abrupt-value next call");
      return {
        done: true,
        get value() {
          throw reason;
        },
      };
    },
  });
  const e = forward(abruptValue);
  await step("e", e);
  // The generator completes abruptly: a later next answers done.
  await step("e.next2", e);

  // A return completion reaching a non-callable return method.
  const notCallableReturn = asyncIterable({
    next() {
      return { value: 1, done: false };
    },
    return: 7,
  });
  const f = forward(notCallableReturn);
  await step("f.next", f);
  await step("f.return", { next: () => f.return("unused") });

  // A return completion whose step result is not an object.
  const nonObjectReturn = asyncIterable({
    next() {
      return { value: 1, done: false };
    },
    return() {
      log("non-object return call");
      return "not an object";
    },
  });
  const g = forward(nonObjectReturn);
  await step("g.next", g);
  await step("g.return", { next: () => g.return("unused") });

  // A throw completion reaching a non-callable throw method.
  const notCallableThrow = asyncIterable({
    next() {
      return { value: 1, done: false };
    },
    throw: 3,
  });
  const h = forward(notCallableThrow);
  await step("h.next", h);
  await step("h.throw", { next: () => h.throw("boom") });

  // A throw completion whose step result is not an object.
  const nonObjectThrow = asyncIterable({
    next() {
      return { value: 1, done: false };
    },
    throw(e) {
      log("non-object throw call", e);
      return 5;
    },
  });
  const i = forward(nonObjectThrow);
  await step("i.next", i);
  await step("i.throw", { next: () => i.throw("boom") });

  // AsyncFromSyncIterator: a synchronous delegate's non-object step result.
  const syncNonObject = syncIterable({
    next() {
      log("sync non-object next call");
      return 9;
    },
  });
  const j = forward(syncNonObject);
  await step("j", j);

  // AsyncFromSyncIterator: a synchronous `value` accessor that throws.
  const syncAbruptValue = syncIterable({
    next() {
      log("sync abrupt-value next call");
      return {
        done: false,
        get value() {
          throw reason;
        },
      };
    },
  });
  const k = forward(syncAbruptValue);
  await step("k", k);

  // AsyncFromSyncIterator: a step that is not done and whose value is a
  // rejected promise closes the synchronous delegate (its return() runs)
  // before the rejection reaches the delegating generator; a done step's
  // rejection does not close it.
  const syncRejectedValue = syncIterable({
    next() {
      log("sync rejected-value next call");
      return { done: false, value: Promise.reject(reason) };
    },
    return() {
      log("sync rejected-value return call");
      return { done: true };
    },
  });
  const l = forward(syncRejectedValue);
  await step("l", l);
  const syncRejectedDone = syncIterable({
    next() {
      log("sync rejected-done next call");
      return { done: true, value: Promise.reject(reason) };
    },
    return() {
      log("sync rejected-done return call");
      return { done: true };
    },
  });
  const m = forward(syncRejectedDone);
  await step("m", m);
  // A return() that throws while closing: the rejection still propagates.
  const syncRejectedThrowingReturn = syncIterable({
    next() {
      return { done: false, value: Promise.reject(reason) };
    },
    return() {
      log("sync throwing-return return call");
      throw new Error("from return");
    },
  });
  const n = forward(syncRejectedThrowingReturn);
  await step("n", n);
}

main().then(
  () => log("passed"),
  (e) => log("failed", e.message),
);
