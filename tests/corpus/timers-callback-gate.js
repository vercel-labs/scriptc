// The same synchronous timer callback gate for a JavaScript source, where
// the callback arrives with no static type at all (no cast to unwrap): a
// non-function throws ERR_INVALID_ARG_TYPE before anything schedules, and
// a function still runs.

const values = [123, null, undefined, "x", {}, true, 10n, Symbol("s")];

function viaTimeout(cb) {
  setTimeout(cb, 1);
}
function viaInterval(cb) {
  setInterval(cb, 1);
}
function viaImmediate(cb) {
  setImmediate(cb);
}
function viaTimeoutArgs(cb) {
  setTimeout(cb, 1, "first", "second");
}

function attempt(label, call, value) {
  try {
    call(value);
    console.log(label, "accepted");
  } catch (e) {
    console.log(label, e instanceof TypeError, e.code, JSON.stringify(e.message));
  }
}

for (const value of values) {
  attempt("setTimeout", viaTimeout, value);
  attempt("setInterval", viaInterval, value);
  attempt("setImmediate", viaImmediate, value);
}

// The trailing arguments evaluate before the gate.
function delay() {
  console.log("delay expression");
  return 1;
}
attempt("trailing", function (cb) {
  setTimeout(cb, delay(), "value");
}, null);

// A function through the same path still runs, and the trailing arguments
// are delivered.
viaTimeout(function () {
  console.log("fired");
});
viaTimeoutArgs(function (a, b) {
  console.log("arguments", a, b);
});

setTimeout(() => console.log("done"), 40);
