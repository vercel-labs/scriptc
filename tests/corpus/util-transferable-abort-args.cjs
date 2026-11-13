// util.transferableAbortSignal validates its argument: every non-signal
// throws ERR_INVALID_ARG_TYPE with Node's argument-validation description
// ("type number (5)", "an instance of Object", "an instance of
// AbortController"), and a signal is accepted and answered as the same
// value. Surplus arguments are evaluated and dropped, and
// util.transferableAbortController answers a fresh, ordinary controller.
"use strict";
const util = require("node:util");

const values = [undefined, null, 5, true, {}, [1], () => {}, new AbortController(), "x"];
for (const value of values) {
  try {
    util.transferableAbortSignal(value);
    console.log("ok", typeof value);
  } catch (e) {
    console.log(e.name, e.code, e.message);
  }
}

const sig = AbortSignal.abort("pre");
const same = util.transferableAbortSignal(sig);
console.log("same", same === sig, sig.aborted, sig.reason);
console.log("surplus", util.transferableAbortSignal(sig, 1, 2) === sig);

const ac = util.transferableAbortController();
console.log("fresh", ac.signal.aborted);
ac.abort("why");
console.log("aborted", ac.signal.aborted, ac.signal.reason);
console.log("ctl surplus", util.transferableAbortController(1, 2).signal.aborted);
