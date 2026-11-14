// process.setUncaughtExceptionCaptureCallback / hasUncaughtExceptionCaptureCallback:
// the flag, Node's validation and "already active" error, the callback
// taking precedence over an uncaughtException listener and an
// uncaughtExceptionMonitor still running, and null clearing the capture.
function attempt(label, fn) {
  try {
    const value = fn();
    console.log(label, "->", value === undefined ? "undefined" : value);
  } catch (error) {
    console.log(label, "|", error.constructor.name, error.code, "|", error.message);
  }
}

attempt("initial", () => process.hasUncaughtExceptionCaptureCallback());
attempt("set-number", () => process.setUncaughtExceptionCaptureCallback(1));
attempt("set-object", () => process.setUncaughtExceptionCaptureCallback({}));
attempt("set-undefined", () => process.setUncaughtExceptionCaptureCallback(undefined));
attempt("set-string", () => process.setUncaughtExceptionCaptureCallback("fn"));
attempt("still-unset", () => process.hasUncaughtExceptionCaptureCallback());

const seen = [];
process.setUncaughtExceptionCaptureCallback((error) => {
  seen.push(error.message);
  console.log("captured", error.message, error instanceof Error, process.hasUncaughtExceptionCaptureCallback());
});

attempt("after-set", () => process.hasUncaughtExceptionCaptureCallback());
attempt("second-callback", () => process.setUncaughtExceptionCaptureCallback(() => {}));
// Validation runs before the already-active check.
attempt("invalid-while-set", () => process.setUncaughtExceptionCaptureCallback(0));
attempt("null-clears", () => process.setUncaughtExceptionCaptureCallback(null));
attempt("after-clear", () => process.hasUncaughtExceptionCaptureCallback());
attempt("seen", () => seen.length);

// A second program-wide install, then an asynchronous throw: the monitor
// runs, the capture callback handles it, the listener does not run, and the
// loop keeps going.
process.setUncaughtExceptionCaptureCallback((error) => {
  console.log("handled", error.message);
});
process.on("uncaughtExceptionMonitor", (error, origin) => {
  console.log("monitor", origin, error.message);
});
process.on("uncaughtException", () => {
  console.log("listener ran");
});
setTimeout(() => {
  throw new Error("boom");
}, 1);
setTimeout(() => {
  console.log("loop continues");
}, 10);
