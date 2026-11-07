// The Promise statics through Function.prototype.call with a `this` that
// is not %Promise%: Promise.all/allSettled/any/race build their capability
// with NewPromiseCapability(C) — `new C(executor)`, whose two arguments
// become the capability's resolve and reject — read C.resolve once BEFORE
// the iterable, call it per element with C as the receiver, and subscribe
// through the element's `then`. resolve/reject build the capability and
// answer its promise. Every observation below is Node's own ordering.
"use strict";

// A capability constructor that logs each step. `cap` holds the functions
// the executor was given, which are the capability's resolve and reject;
// the instance's own resolve/reject are not used by the algorithms. Each
// case has its own `cap`, so nothing carries over between them.
function makeCapabilityCtor(log, cap) {
  function C(executor) {
    log.push(
      "new C(" +
        typeof executor +
        " len=" +
        executor.length +
        " name=[" +
        executor.name +
        "]); ownPrototype=" +
        Object.prototype.hasOwnProperty.call(executor, "prototype"),
    );
    executor(
      function (value) {
        log.push("cap.resolve(" + String(value) + ")");
        cap.resolve = value;
      },
      function (reason) {
        log.push("cap.reject(" + String(reason) + ")");
        cap.reject = reason;
      },
    );
    // Properties on the constructed promise that the algorithms never read
    // for the capability's functions (they come from the executor).
    this.resolve = function () {
      log.push("instance resolve should not run");
    };
    this.reject = function () {
      log.push("instance reject should not run");
    };
    this.tag = "capability";
  }
  return C;
}

function show(label, value) {
  if (value === undefined) return label + "=undefined";
  if (value === null) return label + "=null";
  if (typeof value === "object" || typeof value === "function") {
    return label + "=" + Object.prototype.toString.call(value);
  }
  return label + "=" + String(value);
}

// 1. all: the executor's arguments are the capability functions, C.resolve
//    runs once per element with C as `this`, and each element's `then`
//    receives a fresh resolve function (length 1, empty name, no
//    prototype) plus the capability's reject.
{
  const log = [];
  const cap = { resolve: null, reject: null };
  const C = makeCapabilityCtor(log, cap);
  C.resolve = function (value) {
    log.push("C.resolve(" + value + ") this=C:" + (this === C));
    return {
      then: function (onFulfilled, onRejected) {
        log.push(
          "then(" +
            value +
            ") resolve:" +
            typeof onFulfilled +
            " len=" +
            onFulfilled.length +
            " name=[" +
            onFulfilled.name +
            "]; ownPrototype=" +
            Object.prototype.hasOwnProperty.call(onFulfilled, "prototype") +
            " reject:" +
            typeof onRejected,
        );
        onFulfilled(value * 10);
      },
    };
  };
  const returned = Promise.all.call(C, [1, 2, 3]);
  log.push("returns " + show("promise", returned) + " tag=" + returned.tag);
  console.log("all: " + log.join(" | "));
  console.log("all: resolved=" + cap.resolve.join(",") + " rejected=" + cap.reject);
}

// 2. allSettled: two fresh functions per element share one [[AlreadyCalled]];
//    entries settle into { status, value | reason } records.
{
  const log = [];
  const cap = { resolve: null, reject: null };
  const C = makeCapabilityCtor(log, cap);
  C.resolve = function (value) {
    return {
      then: function (onFulfilled, onRejected) {
        log.push(
          "then(" +
            value +
            ") resolve:" +
            typeof onFulfilled +
            " reject:" +
            typeof onRejected +
            " same=" +
            (onFulfilled === onRejected),
        );
        if (value === 2) onRejected("bad" + value);
        else onFulfilled(value);
      },
    };
  };
  Promise.allSettled.call(C, [1, 2, 3]);
  const summary = [];
  for (let i = 0; i < cap.resolve.length; i++) {
    const record = cap.resolve[i];
    summary.push(record.status + ":" + (record.status === "fulfilled" ? record.value : record.reason));
  }
  console.log("allSettled: " + log.join(" | "));
  console.log("allSettled: settled=" + summary.join(","));
}

// 3. any: every rejection stores its reason; the last one rejects the
//    capability with an AggregateError whose errors are those reasons.
{
  const log = [];
  const cap = { resolve: null, reject: null };
  const C = makeCapabilityCtor(log, cap);
  C.resolve = function (value) {
    return {
      then: function (onFulfilled, onRejected) {
        onRejected(value * 100);
      },
    };
  };
  Promise.any.call(C, [1, 2]);
  console.log("any: " + log.join(" | "));
  console.log(
    "any: rejected=" +
      cap.reject.name +
      " message=[" +
      cap.reject.message +
      "] errors=" +
      cap.reject.errors.length +
      ":" +
      cap.reject.errors.join(","),
  );
}

// 4. any with an early fulfillment: the fulfillments settle the capability
//    and later rejections only count down.
{
  const log = [];
  const cap = { resolve: null, reject: null };
  const C = makeCapabilityCtor(log, cap);
  C.resolve = function (value) {
    return {
      then: function (onFulfilled, onRejected) {
        if (value === 2) onFulfilled(value);
        else onRejected(value);
      },
    };
  };
  Promise.any.call(C, [1, 2, 3]);
  console.log("any first: " + log.join(" | "));
  console.log("any first: resolved=" + cap.resolve + " rejected=" + cap.reject);
}

// 5. race passes the capability's OWN functions to `then`.
{
  const log = [];
  let instance = null;
  function R(executor) {
    let resolve;
    let reject;
    executor(
      function (value) {
        log.push("cap.resolve(" + value + ")");
      },
      function (reason) {
        log.push("cap.reject(" + reason + ")");
      },
    );
    this.resolve = resolve;
    this.reject = reject;
    instance = this;
  }
  R.resolve = function (value) {
    return {
      then: function (onFulfilled, onRejected) {
        log.push("then(" + value + ") ownResolve=" + (typeof onFulfilled));
        onFulfilled(value);
      },
    };
  };
  const returned = Promise.race.call(R, [7, 8]);
  console.log("race: " + log.join(" | ") + " samePromise=" + (returned === instance));
}

// 6. resolve and reject answer the capability's promise, after calling the
//    capability's own function with the value.
{
  const log = [];
  const cap = { resolve: null, reject: null };
  const C = makeCapabilityCtor(log, cap);
  const resolved = Promise.resolve.call(C, 42);
  log.push("resolved " + show("promise", resolved) + " tag=" + resolved.tag);
  const rejected = Promise.reject.call(C, "why");
  log.push("rejected " + show("promise", rejected) + " tag=" + rejected.tag);
  console.log("statics: " + log.join(" | "));
}

// 7. GetPromiseResolve runs before the iterable is touched; C.resolve is
//    read exactly once.
{
  const log = [];
  let reads = 0;
  function C(executor) {
    executor(function () {}, function () {});
  }
  Object.defineProperty(C, "resolve", {
    get: function () {
      reads++;
      log.push("read resolve #" + reads);
      return function (value) {
        return { then: function (onFulfilled) { onFulfilled(value); } };
      };
    },
  });
  const iterable = {
    [Symbol.iterator]: function () {
      log.push("get iterator");
      return {
        next: function () {
          return { done: true };
        },
      };
    },
  };
  Promise.all.call(C, iterable);
  console.log("order: " + log.join(" | ") + " reads=" + reads);
}

// 8. A non-callable C.resolve rejects the capability with a TypeError
//    instead of throwing; the iterable is never touched.
{
  const log = [];
  const cap = { resolve: null, reject: null };
  const C = makeCapabilityCtor(log, cap);
  C.resolve = undefined;
  const iterable = {
    [Symbol.iterator]: function () {
      log.push("get iterator should not run");
      return { next: function () { return { done: true }; } };
    },
  };
  Promise.all.call(C, iterable);
  const reason = cap.reject;
  console.log(
    "not callable: " + log.join(" | ") + " reason=" + reason.name + " message=[" + reason.message + "]",
  );
}

// 9. A throwing C.resolve getter rejects with that error.
{
  const log = [];
  const cap = { resolve: null, reject: null };
  const C = makeCapabilityCtor(log, cap);
  Object.defineProperty(C, "resolve", {
    get: function () {
      throw new RangeError("bad getter");
    },
  });
  Promise.all.call(C, [1]);
  console.log(
    "getter throws: " + log.join(" | ") + " reason=" + cap.reject.name + " message=[" + cap.reject.message + "]",
  );
}

// 10. A `this` that is not an object throws synchronously, before any
//     capability exists.
{
  const messages = [];
  function attempt(name, run) {
    try {
      run();
      messages.push(name + ": no throw");
    } catch (error) {
      messages.push(name + ": " + error.name + " [" + error.message + "]");
    }
  }
  attempt("all", function () {
    Promise.all.call(undefined, []);
  });
  attempt("allSettled", function () {
    Promise.allSettled.call(null, []);
  });
  attempt("any", function () {
    Promise.any.call(42, []);
  });
  attempt("race", function () {
    Promise.race.call("text", []);
  });
  attempt("resolve", function () {
    Promise.resolve.call(true, 1);
  });
  attempt("reject", function () {
    Promise.reject.call(undefined, 1);
  });
  console.log("non-object this: " + messages.join(" | "));
}

// 11. A non-constructor `this` throws synchronously.
{
  let thrown = "none";
  try {
    Promise.all.call({}, []);
  } catch (error) {
    thrown = error.name + " [" + error.message + "]";
  }
  console.log("non-constructor this: " + thrown);
}

// 12. A constructor that never calls its executor, and one that passes
//     non-callable values, throw Node's TypeError synchronously.
{
  function Silent(executor) {
    this.resolve = function () {};
    this.reject = function () {};
  }
  function BadArgs(executor) {
    executor(1, 2);
  }
  const outcomes = [];
  for (const ctor of [Silent, BadArgs]) {
    try {
      Promise.all.call(ctor, []);
      outcomes.push("no throw");
    } catch (error) {
      outcomes.push(error.name + " [" + error.message + "]");
    }
  }
  console.log("bad capabilities: " + outcomes.join(" | "));
}

// 13. Invoking the executor twice with non-undefined arguments throws.
{
  const log = [];
  function Twice(executor) {
    executor(function () {}, function () {});
    try {
      executor("again", "again");
      log.push("second call allowed");
    } catch (error) {
      log.push("second call: " + error.name + " [" + error.message + "]");
    }
  }
  Promise.all.call(Twice, []);
  console.log("executor twice: " + log.join(" | "));
}

// 14. `%Promise%` itself keeps the native implementation: the same calls
//     answer native promises, in microtask order.
{
  const log = [];
  const all = Promise.all.call(Promise, [1, 2]);
  log.push("all is promise: " + (all instanceof Promise));
  all.then(function (values) {
    log.push("all values: " + values.join(","));
  });
  Promise.allSettled.call(Promise, [1]).then(function (entries) {
    log.push("allSettled status: " + entries[0].status + ":" + entries[0].value);
  });
  Promise.race.call(Promise, [3, 4]).then(function (value) {
    log.push("race value: " + value);
  });
  Promise.any.call(Promise, [5]).then(function (value) {
    log.push("any value: " + value);
  });
  const same = Promise.resolve.call(Promise, all);
  log.push("resolve returns the promise: " + (same === all));
  Promise.reject.call(Promise, new Error("nope")).catch(function (error) {
    log.push("reject reason: " + error.message);
  });
  queueMicrotask(function () {
    log.push("microtask");
  });
  log.push("sync tail");
  setTimeout(function () {
    console.log("native: " + log.join(" | "));
  }, 0);
}

console.log("after sync");

// 15. IteratorClose: a throwing C.resolve on the second element closes the
//     generator and rejects the capability with the resolve error.
{
  const log = [];
  const cap = { resolve: null, reject: null };
  const C = makeCapabilityCtor(log, cap);
  let calls = 0;
  C.resolve = function (value) {
    calls++;
    log.push("C.resolve(" + value + ") #" + calls);
    if (calls === 2) throw new RangeError("resolve blew up");
    return {
      then: function (onFulfilled) {
        onFulfilled(value);
      },
    };
  };
  function* source() {
    try {
      yield 1;
      yield 2;
      yield 3;
    } finally {
      log.push("generator closed");
    }
  }
  Promise.all.call(C, source());
  console.log(
    "close: " + log.join(" | ") + " reason=" + cap.reject.name + " [" + cap.reject.message + "]",
  );
}

// 16. Surplus arguments: the algorithm reads only the receiver and the
//     iterable, but every argument evaluates first, in source order, and an
//     abrupt argument throws before the capability exists.
{
  const log = [];
  const cap = { resolve: null, reject: null };
  const C = makeCapabilityCtor(log, cap);
  const iterable = {
    [Symbol.iterator]() {
      log.push("iterate");
      return {
        next() {
          return { done: true, value: undefined };
        },
      };
    },
  };
  const sideEffect = function (name) {
    return function (value) {
      log.push("arg " + name + "(<" + value + ">)");
      return value;
    };
  };
  Promise.all.call(C, (log.push("this"), iterable), sideEffect("a")(2), sideEffect("b")(3));
  console.log("surplus order: " + log.join(" | "));

  const thrown = [];
  const throwing = makeCapabilityCtor(thrown, { resolve: null, reject: null });
  try {
    Promise.all.call(
      throwing,
      [1],
      function () {
        throw new Error("surplus threw");
      },
    );
  } catch (error) {
    // The argument throws while the call argument list evaluates, so the
    // constructor never runs and nothing was logged.
    console.log("surplus throws: " + error.message + " log=[" + thrown.join(" | ") + "]");
  }

  // A binding the checker types Promise<T> keeps the constructed foreign
  // instance as dyn: its tag is not part of a native promise, so a typed
  // slot would read undefined and lose the value.
  const held = [];
  const Holder = makeCapabilityCtor(held, { resolve: null, reject: null });
  const heldStatic = Promise.all.call(Holder, iterable, sideEffect("c")(4));
  console.log(
    "surplus binding: tag=" + heldStatic.tag + " instanceof=" + (heldStatic instanceof Holder),
  );
}
