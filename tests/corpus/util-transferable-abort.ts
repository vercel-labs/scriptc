// util.transferableAbortSignal marks a signal transferable and answers the
// very same signal: aborting through the controller is seen through it, its
// listeners run, and the live handle keeps its identity. The signal may
// already be aborted. util.transferableAbortController is an ordinary
// AbortController whose signal is marked the same way.
import { transferableAbortController, transferableAbortSignal } from "node:util";

const ac = new AbortController();
const marked: AbortSignal = transferableAbortSignal(ac.signal);
console.log(marked === ac.signal, marked.aborted);

let events = 0;
marked.addEventListener("abort", () => {
  events++;
});
ac.abort("stop");
console.log(marked.aborted, marked.reason, events);

const pre = AbortSignal.abort("pre");
const samePre = transferableAbortSignal(pre);
console.log(samePre === pre, pre.aborted, pre.reason);

const ctl = transferableAbortController();
const signal = ctl.signal;
console.log(signal.aborted);
ctl.abort("why");
console.log(signal.aborted, signal.reason);

// A composed signal is marked and answered the same way.
const any = AbortSignal.any([ac.signal]);
console.log(transferableAbortSignal(any) === any, any.aborted, any.reason);
